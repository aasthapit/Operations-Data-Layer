// Turning a table into a file the browser saves: the CSV text and the click
// that downloads it. Shared by the query page and the data table, which both
// offer "every row the filters left" as a download, so the escaping rules and
// the download dance exist once.

export function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function download(filename: string, text: string, mime: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false; // no object URLs, or the browser refused the download
  }
}
