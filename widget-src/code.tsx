/**
 * Notion Table Sync — Figma widget that renders a Notion database as an interactive table.
 * Requires a CORS proxy (see proxy/worker.js). Configure via widget property menu.
 */
const { widget } = figma;
const {
  AutoLayout,
  Text,
  Input,
  useSyncedState,
  usePropertyMenu,
  useEffect,
} = widget;

import type { ColumnDef, RowData } from "./notion-types";
import {
  parseNotionColumns,
  parseNotionProperties,
  buildNotionPropertyUpdate,
  formatCellForDisplay,
  isReadOnlyType,
  mergeSchemaOptions,
  NOTION_TYPE_LABELS,
  NOTION_PILL_COLORS,
} from "./notion-parsers";
import type { NotionDatabaseQueryResponse, NotionDatabaseResponse } from "./notion-types";

type TableSize = "small" | "medium" | "large";

const TABLE_SIZES: Record<
  TableSize,
  {
    cellWidth: number;
    headerHeight: number;
    rowHeight: number;
    rowHeightEdit: number;
    headerFont: number;
    headerTypeFont: number;
    cellFont: number;
    cellPillFont: number;
    groupFont: number;
    groupCountFont: number;
    padding: number;
    groupPadding: number;
  }
> = {
  small: {
    cellWidth: 220,
    headerHeight: 56,
    rowHeight: 44,
    rowHeightEdit: 90,
    headerFont: 22,
    headerTypeFont: 14,
    cellFont: 20,
    cellPillFont: 16,
    groupFont: 20,
    groupCountFont: 16,
    padding: 8,
    groupPadding: 6,
  },
  medium: {
    cellWidth: 350,
    headerHeight: 72,
    rowHeight: 64,
    rowHeightEdit: 124,
    headerFont: 34,
    headerTypeFont: 22,
    cellFont: 32,
    cellPillFont: 26,
    groupFont: 32,
    groupCountFont: 26,
    padding: 12,
    groupPadding: 9,
  },
  large: {
    cellWidth: 500,
    headerHeight: 96,
    rowHeight: 88,
    rowHeightEdit: 160,
    headerFont: 50,
    headerTypeFont: 32,
    cellFont: 48,
    cellPillFont: 40,
    groupFont: 48,
    groupCountFont: 40,
    padding: 16,
    groupPadding: 10,
  },
};

/** Normalize Notion database ID: strip dashes, extract 32-char hex from URL if pasted. */
function normalizeDatabaseId(input: string): string {
  const trimmed = input.trim();
  // Extract 32-char hex block (Notion IDs are 32 hex chars, with or without dashes)
  const hexMatch = trimmed.match(/([a-f0-9]{32})/i);
  if (hexMatch) return hexMatch[1].toLowerCase();
  // Otherwise strip dashes from UUID format
  return trimmed.replace(/-/g, "").toLowerCase();
}

function NotionTableWidget() {
  const [proxyUrl, setProxyUrl] = useSyncedState("proxyUrl", "");
  const [databaseId, setDatabaseId] = useSyncedState("databaseId", "");
  const [columns, setColumns] = useSyncedState<ColumnDef[]>("columns", []);
  const [rows, setRows] = useSyncedState<RowData[]>("rows", []);
  const [lastSynced, setLastSynced] = useSyncedState("lastSynced", "");
  const [error, setError] = useSyncedState("error", "");
  const [editingCell, setEditingCell] = useSyncedState<{
    pageId: string;
    property: string;
    columnType: string;
    value: string;
  } | null>("editingCell", null);
  const [sortBy, setSortBy] = useSyncedState("sortBy", "");
  const [groupBy, setGroupBy] = useSyncedState("groupBy", "");
  const [filtersConfig, setFiltersConfig] = useSyncedState("filtersConfig", "");

  function parseFilters(): { column: string; op: string; value: string }[] {
    return filtersConfig
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("::");
        const colInput = parts[0]?.trim() ?? "";
        const op = (parts[1]?.trim() ?? "contains") as "contains" | "equals" | "is_empty" | "is_not_empty";
        const value = parts[2]?.trim() ?? "";
        const col = columns.find(
          (c) =>
            c.propertyName === colInput ||
            c.name === colInput ||
            c.propertyName.toLowerCase() === colInput.toLowerCase() ||
            c.name.toLowerCase() === colInput.toLowerCase()
        );
        return col ? { column: col.propertyName, op, value } : null;
      })
      .filter((f): f is { column: string; op: string; value: string } => f !== null);
  }
  const [tableSize, setTableSize] = useSyncedState<TableSize>("tableSize", "medium");
  const [columnOrder, setColumnOrder] = useSyncedState("columnOrder", "");
  const [hiddenColumns, setHiddenColumns] = useSyncedState("hiddenColumns", "");
  const [showFooter, setShowFooter] = useSyncedState("showFooter", true);

  function buildSorts(): { property?: string; timestamp?: string; direction: "ascending" | "descending" }[] {
    if (!sortBy) return [];
    const [key, dir] = sortBy.split(":");
    const direction = (dir === "desc" ? "descending" : "ascending") as "ascending" | "descending";
    if (key === "created_time" || key === "last_edited_time") {
      return [{ timestamp: key, direction }];
    }
    return key ? [{ property: key, direction }] : [];
  }

  async function fetchFromNotion() {
    if (!proxyUrl.trim() || !databaseId.trim()) {
      setError("Enter proxy URL and database ID above, then Sync.");
      return;
    }
    setError("");
    const base = proxyUrl.replace(/\/$/, "");
    const normalizedId = normalizeDatabaseId(databaseId);
    const sorts = buildSorts();
    const queryBody = sorts.length > 0 ? { sorts } : {};
    try {
      const [schemaRes, queryRes] = await Promise.all([
        fetch(`${base}/notion/databases/${normalizedId}`),
        fetch(`${base}/notion/databases/${normalizedId}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(queryBody),
        }),
      ]);
      if (!queryRes.ok) {
        const t = await queryRes.text();
        let errMsg = `Notion API: ${queryRes.status} ${t.slice(0, 100)}`;
        if (queryRes.status === 404 || t.includes("could not find") || t.includes("locate database")) {
          errMsg =
            "Database not found. Share it with your integration: open the database → ⋯ → Connections → Add → select your integration.";
        }
        setError(errMsg);
        return;
      }
      const schema: NotionDatabaseResponse | null = schemaRes.ok
        ? ((await schemaRes.json()) as NotionDatabaseResponse)
        : null;
      const data = (await queryRes.json()) as NotionDatabaseQueryResponse;
      const results = data.results || [];
      const parsedColumns = mergeSchemaOptions(parseNotionColumns(results), schema);
      const parsedRows: RowData[] = results.map((page) => ({
        pageId: page.id,
        cells: parseNotionProperties(page.properties),
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
      }));
      setColumns(parsedColumns);
      setRows(parsedRows);
      setLastSynced(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveCellEdit(newValue: string) {
    const cell = editingCell;
    if (!cell) return;
    setEditingCell(null);
    const base = proxyUrl.replace(/\/$/, "");
    const url = `${base}/notion/pages/${cell.pageId}`;
    const col = columns.find((c) => c.propertyName === cell.property);
    const type = cell.columnType ?? (col?.type ?? "rich_text");
    const payload = buildNotionPropertyUpdate(cell.property, type, newValue);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: payload }),
      });
      if (!res.ok) {
        const t = await res.text();
        setError(`Update failed: ${res.status} ${t.slice(0, 80)}`);
      } else {
        setRows((prev) =>
          prev.map((row) =>
            row.pageId === cell.pageId
              ? {
                  ...row,
                  cells: { ...row.cells, [cell.property]: newValue },
                }
              : row
          )
        );
        setError("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function editCell(
    pageId: string,
    propertyName: string,
    columnType: string,
    currentValue: string
  ) {
    setEditingCell({ pageId, property: propertyName, columnType, value: currentValue });
  }

  const sortOptions = [
    { option: "", label: "Sort: None" },
    ...columns.flatMap((c) => [
      { option: `${c.propertyName}:asc`, label: `${c.name} ↑` },
      { option: `${c.propertyName}:desc`, label: `${c.name} ↓` },
    ]),
    { option: "created_time:asc", label: "Created ↑" },
    { option: "created_time:desc", label: "Created ↓" },
    { option: "last_edited_time:asc", label: "Last edited ↑" },
    { option: "last_edited_time:desc", label: "Last edited ↓" },
  ];
  const groupOptions = [
    { option: "", label: "Group: None" },
    ...columns.map((c) => ({ option: c.propertyName, label: `By ${c.name}` })),
  ];
  const tableSizeOptions = [
    { option: "small", label: "Size: Small" },
    { option: "medium", label: "Size: Medium" },
    { option: "large", label: "Size: Large" },
  ];
  const menuItems: Parameters<typeof usePropertyMenu>[0] = [
    { itemType: "action", propertyName: "sync", tooltip: "Sync from Notion" },
    {
      itemType: "dropdown",
      propertyName: "tableSize",
      tooltip: "Table size",
      selectedOption: tableSizeOptions.some((o) => o.option === tableSize) ? tableSize : "medium",
      options: tableSizeOptions,
    },
    { itemType: "separator" },
    {
      itemType: "dropdown",
      propertyName: "sort",
      tooltip: "Sort by",
      selectedOption: sortOptions.some((o) => o.option === sortBy) ? sortBy : "",
      options: sortOptions,
    },
    {
      itemType: "dropdown",
      propertyName: "group",
      tooltip: "Group by",
      selectedOption: groupOptions.some((o) => o.option === groupBy) ? groupBy : "",
      options: groupOptions,
    },
    {
      itemType: "toggle",
      propertyName: "showFooter",
      tooltip: "Show footer",
      isToggled: showFooter,
    },
  ];
  usePropertyMenu(menuItems, async ({ propertyName, propertyValue }) => {
    if (propertyName === "sync") await fetchFromNotion();
    else if (propertyName === "tableSize") {
      const next =
        propertyValue === "small" || propertyValue === "medium" || propertyValue === "large"
          ? propertyValue
          : "medium";
      setTableSize(next);
      figma.notify(`Table size: ${next}`);
    }
    else if (propertyName === "sort") setSortBy(propertyValue ?? "");
    else if (propertyName === "group") setGroupBy(propertyValue ?? "");
    else if (propertyName === "showFooter") setShowFooter((prev) => !prev);
  });

  // Load saved config from clientStorage when widget mounts (e.g. after configuring via Plugins → Development)
  useEffect(() => {
    if (proxyUrl.trim() !== "" && databaseId.trim() !== "") return;
    figma.clientStorage.getAsync("notionTableConfig").then((saved) => {
      if (!saved || typeof saved !== "object") return;
      const o = saved as { proxyUrl?: string; databaseId?: string };
      if (o.proxyUrl && o.databaseId) {
        setProxyUrl(o.proxyUrl);
        setDatabaseId(o.databaseId);
        figma.notify("Loaded saved configuration");
      }
    });
    return () => {};
  }, []);

  function getFilteredRows(): RowData[] {
    const filters = parseFilters();
    if (!filters.length) return rows;

    return rows.filter((row) => {
      for (const { column, op, value } of filters) {
        const val = value.trim().toLowerCase();
        const needsValue = op !== "is_empty" && op !== "is_not_empty";
        if (needsValue && !val) continue;
        const cellVal = (row.cells[column] ?? "").toLowerCase();
        const isEmpty = !cellVal || cellVal === "—";
        let pass = false;
        switch (op) {
          case "contains":
            pass = cellVal.includes(val);
            break;
          case "equals":
            pass = cellVal === val;
            break;
          case "is_empty":
            pass = isEmpty;
            break;
          case "is_not_empty":
            pass = !isEmpty;
            break;
          default:
            pass = true;
        }
        if (!pass) return false;
      }
      return true;
    });
  }

  function getCellSortValue(row: RowData, key: string): string | number {
    if (key === "created_time" || key === "last_edited_time") {
      const t = row[key];
      return t ?? "";
    }
    const v = row.cells[key] ?? "";
    const col = columns.find((c) => c.propertyName === key);
    if (col?.type === "number") {
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    }
    return v.toLowerCase();
  }

  function getSortedRows(): RowData[] {
    const filtered = getFilteredRows();
    if (!sortBy) return filtered;
    const [key, dir] = sortBy.split(":");
    if (!key) return rows;
    const asc = dir !== "desc";
    return [...filtered].sort((a, b) => {
      const va = getCellSortValue(a, key);
      const vb = getCellSortValue(b, key);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  }

  function getGroupedRows(): { groupValue: string; rows: RowData[] }[] {
    const sorted = getSortedRows();
    if (!groupBy || !columns.some((c) => c.propertyName === groupBy)) {
      return [{ groupValue: "", rows: sorted }];
    }
    const map = new Map<string, RowData[]>();
    for (const row of sorted) {
      const val = row.cells[groupBy] ?? "—";
      if (!map.has(val)) map.set(val, []);
      map.get(val)!.push(row);
    }
    const col = columns.find((c) => c.propertyName === groupBy);
    const sortedKeys = Array.from(map.keys()).sort((a, b) => {
      if (col?.type === "number") {
        const na = parseFloat(a);
        const nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
      }
      return a.localeCompare(b);
    });
    return sortedKeys.map((groupValue) => ({
      groupValue,
      rows: map.get(groupValue)!,
    }));
  }

  const hasData = columns.length > 0 && rows.length >= 0;
  const sz = TABLE_SIZES[tableSize];

  const getColumnWidth = (col: ColumnDef) =>
    col.type === "title" || col.type === "date" || col.type === "rich_text"
      ? Math.round(sz.cellWidth * 1.5)
      : sz.cellWidth;

  const orderedColumns =
    columnOrder.trim().length > 0
      ? (() => {
          const order = columnOrder.split(",").map((s) => s.trim()).filter(Boolean);
          const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
          const ordered: ColumnDef[] = [];
          const used = new Set<ColumnDef>();
          for (const name of order) {
            const col = byName.get(name.toLowerCase());
            if (col && !used.has(col)) {
              ordered.push(col);
              used.add(col);
            }
          }
          for (const col of columns) {
            if (!used.has(col)) ordered.push(col);
          }
          return ordered.length > 0 ? ordered : columns;
        })()
      : columns;

  const hiddenSet = new Set(
    hiddenColumns
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const displayColumns = orderedColumns.filter(
    (c) => !hiddenSet.has(c.name.toLowerCase()) && !hiddenSet.has(c.propertyName.toLowerCase())
  );
  const displaySync = lastSynced
    ? new Date(lastSynced).toLocaleString()
    : "Never";

  if (!hasData && !error) {
    return (
      <AutoLayout
        direction="vertical"
        padding={24}
        fill="#F5F5F5"
        stroke="#E0E0E0"
        cornerRadius={8}
        spacing={12}
      >
        <Text fontSize={14} fontWeight="bold" fill="#333">
          Notion Table Sync
        </Text>
        <AutoLayout direction="vertical" spacing={4}>
          <Text fontSize={11} fill="#666">
            Proxy URL (e.g. https://xxx.workers.dev)
          </Text>
          <Input
            value={proxyUrl || null}
            placeholder="https://your-proxy.workers.dev"
            onTextEditEnd={(e) => {
              setProxyUrl(e.characters);
              figma.clientStorage.setAsync("notionTableConfig", {
                proxyUrl: e.characters,
                databaseId,
              });
            }}
            fontSize={11}
            width={280}
            inputFrameProps={{ fill: "#FFFFFF", padding: 8, cornerRadius: 4 }}
          />
        </AutoLayout>
        <AutoLayout direction="vertical" spacing={4}>
          <Text fontSize={11} fill="#666">
            Notion Database ID (from database URL)
          </Text>
          <Input
            value={databaseId || null}
            placeholder="Paste URL or 32-char ID"
            onTextEditEnd={(e) => {
              setDatabaseId(e.characters);
              figma.clientStorage.setAsync("notionTableConfig", {
                proxyUrl,
                databaseId: e.characters,
              });
            }}
            fontSize={11}
            width={280}
            inputFrameProps={{ fill: "#FFFFFF", padding: 8, cornerRadius: 4 }}
          />
        </AutoLayout>
        <Text fontSize={10} fill="#999">
          Share database with integration: ⋯ → Connections → Add. Then Sync.
        </Text>
      </AutoLayout>
    );
  }

  return (
    <AutoLayout
      key={tableSize}
      direction="vertical"
      spacing={0}
      cornerRadius={8}
      fill="#FFFFFF"
      stroke="#E0E0E0"
    >
      {error ? (
        <AutoLayout padding={8} fill="#FFEBEE">
          <Text fontSize={10} fill="#C62828">
            {error}
          </Text>
        </AutoLayout>
      ) : null}
      <AutoLayout direction="horizontal" spacing={0} padding={0}>
        {displayColumns.map((col, i) => (
          <AutoLayout
            key={i}
            direction="vertical"
            width={getColumnWidth(col)}
            height={sz.headerHeight}
            padding={sz.padding}
            fill="#F5F5F5"
            stroke="#E0E0E0"
            strokeAlign="inside"
            spacing={2}
          >
            <Text fontSize={sz.headerFont} fontWeight="bold" fill="#333" truncate={false} width="fill-parent">
              {col.name}
            </Text>
            <Text fontSize={sz.headerTypeFont} fill="#888">
              {NOTION_TYPE_LABELS[col.type] ?? col.type}
            </Text>
          </AutoLayout>
        ))}
      </AutoLayout>
      {getGroupedRows().map((group, groupIdx) => (
        <AutoLayout key={groupIdx} direction="vertical" spacing={0}>
          {group.groupValue ? (
            <AutoLayout
              direction="horizontal"
              width={displayColumns.reduce((s, c) => s + getColumnWidth(c), 0)}
              padding={sz.groupPadding}
              fill="#E8EAF6"
              stroke="#C5CAE9"
              strokeAlign="inside"
            >
              <Text fontSize={sz.groupFont} fontWeight="bold" fill="#3949AB">
                {group.groupValue}
              </Text>
              <Text fontSize={sz.groupCountFont} fill="#5C6BC0">
                {" "}({group.rows.length})
              </Text>
            </AutoLayout>
          ) : null}
          {group.rows.map((row, rowIdx) => {
            const rowHasEditingSelect =
              editingCell?.pageId === row.pageId &&
              columns.some(
                (c) =>
                  c.propertyName === editingCell?.property &&
                  (c.type === "select" || c.type === "status")
              );
            const rowH = rowHasEditingSelect ? sz.rowHeightEdit : sz.rowHeight;
            return (
            <AutoLayout key={rowIdx} direction="horizontal" spacing={0}>
          {displayColumns.map((col, colIdx) => {
            const isEditing =
              editingCell?.pageId === row.pageId && editingCell?.property === col.propertyName;
            const cellValue = row.cells[col.propertyName] ?? "";
            const displayValue = formatCellForDisplay(col.type, cellValue);
            const readOnly = isReadOnlyType(col.type);
            const canEdit = !readOnly && !isEditing;
            const isSelectOrStatus = col.type === "select" || col.type === "status";
            const pillOpt = col.options?.find((o) => o.name === cellValue);
            const pillColors = pillOpt
              ? NOTION_PILL_COLORS[pillOpt.color ?? "default"] ?? NOTION_PILL_COLORS.default
              : NOTION_PILL_COLORS.default;
            const cellFill =
              readOnly ? "#F9F9F9" : col.type === "checkbox" ? "#FAFAFA" : "#FFFFFF";
            const textFill =
              col.type === "checkbox" && displayValue === "✓"
                ? "#2E7D32"
                : col.type === "date"
                  ? "#1565C0"
                  : col.type === "url"
                    ? "#0D47A1"
                    : readOnly
                      ? "#757575"
                      : "#333";
            const hasWrapColumns = displayColumns.some(
              (c) => c.type === "title" || c.type === "date" || c.type === "rich_text"
            );
            const cellH = hasWrapColumns ? rowH * 2 : rowH;
            return (
              <AutoLayout
                key={colIdx}
                width={getColumnWidth(col)}
                height={cellH}
                padding={sz.padding}
                stroke="#EEEEEE"
                strokeAlign="inside"
                fill={cellFill}
                onClick={() => canEdit && editCell(row.pageId, col.propertyName, col.type, cellValue)}
              >
                {isEditing ? (
                  <AutoLayout direction="vertical" spacing={6} width="fill-parent">
                    {isSelectOrStatus && col.options && col.options.length > 0 ? (
                      <AutoLayout direction="horizontal" spacing={4} wrap>
                        {col.options.map((opt) => {
                          const c = NOTION_PILL_COLORS[opt.color ?? "default"] ?? NOTION_PILL_COLORS.default;
                          const isSelected = opt.name === (editingCell!.value ?? "");
                          return (
                            <AutoLayout
                              key={opt.name}
                              padding={4}
                              cornerRadius={4}
                              fill={isSelected ? c.bg : "#F3F4F6"}
                              stroke={isSelected ? "#9CA3AF" : []}
                              onClick={() => saveCellEdit(opt.name)}
                            >
                              <Text fontSize={sz.cellPillFont} fill={c.text}>
                                {opt.name}
                              </Text>
                            </AutoLayout>
                          );
                        })}
                      </AutoLayout>
                    ) : null}
                    <Input
                      value={typeof editingCell!.value === "string" ? editingCell!.value : null}
                      placeholder={isSelectOrStatus ? "Or type custom value" : "—"}
                      onTextEditEnd={(e) => saveCellEdit(e.characters)}
                      fontSize={sz.cellFont}
                      width="fill-parent"
                      inputBehavior="truncate"
                      inputFrameProps={{ fill: "#FFFFFF", padding: 6 }}
                    />
                  </AutoLayout>
                ) : isSelectOrStatus && displayValue ? (
                  <AutoLayout
                    padding={{ left: 6, right: 6, top: 4, bottom: 4 }}
                    cornerRadius={6}
                    fill={pillColors.bg}
                  >
                    <Text fontSize={sz.cellPillFont} fill={pillColors.text}>
                      {displayValue}
                    </Text>
                  </AutoLayout>
                ) : (
                  <Text
                    fontSize={sz.cellFont}
                    fill={textFill}
                    width="fill-parent"
                    truncate={hasWrapColumns ? 3 : false}
                  >
                    {displayValue}
                  </Text>
                )}
              </AutoLayout>
            );
          })}
        </AutoLayout>
            );
          })}
        </AutoLayout>
      ))}
      {showFooter ? (
      <AutoLayout direction="vertical" padding={8} fill="#FAFAFA" spacing={6}>
        <AutoLayout direction="vertical" spacing={4}>
          <Text fontSize={9} fill="#666">
            Filters (one per line: Column::op::value). Ops: contains, equals, is_empty, is_not_empty
          </Text>
          <Input
            value={filtersConfig || null}
            placeholder="e.g. Status::equals::Done"
            onTextEditEnd={(e) => setFiltersConfig(e.characters)}
            fontSize={10}
            width="fill-parent"
            inputBehavior="multiline"
            inputFrameProps={{ fill: "#FFFFFF", padding: 6, cornerRadius: 4 }}
          />
        </AutoLayout>
        <AutoLayout direction="vertical" spacing={4}>
          <Text fontSize={9} fill="#666">
            Column order (comma-separated, e.g. Name, Version, Status):
          </Text>
          <Input
            value={columnOrder || null}
            placeholder="Leave empty for API order"
            onTextEditEnd={(e) => setColumnOrder(e.characters)}
            fontSize={10}
            width="fill-parent"
            inputFrameProps={{ fill: "#FFFFFF", padding: 6, cornerRadius: 4 }}
          />
        </AutoLayout>
        <AutoLayout direction="vertical" spacing={4}>
          <Text fontSize={9} fill="#666">
            Hidden columns (comma-separated, e.g. Dates, At Issues):
          </Text>
          <Input
            value={hiddenColumns || null}
            placeholder="Leave empty to show all"
            onTextEditEnd={(e) => setHiddenColumns(e.characters)}
            fontSize={10}
            width="fill-parent"
            inputFrameProps={{ fill: "#FFFFFF", padding: 6, cornerRadius: 4 }}
          />
        </AutoLayout>
        <Text fontSize={9} fill="#999">
          Last synced: {displaySync}
          {parseFilters().length > 0 ? ` · Showing ${getFilteredRows().length} of ${rows.length}` : ""}
        </Text>
      </AutoLayout>
      ) : null}
    </AutoLayout>
  );
}

widget.register(NotionTableWidget);
