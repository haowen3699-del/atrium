import { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";

/** 树内节点 */
type Node =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; c: Node[] }
  | { t: "i"; c: Node[] }
  | { t: "link"; href: string; c: Node[] };

/** 块内联解析：加粗/斜体/行内代码/链接（安全，不注入 HTML） */
function parseInline(src: string): Node[] {
  const out: Node[] = [];
  let i = 0;
  const pushText = (s: string) => { if (s) out.push({ t: "text", v: s }); };
  while (i < src.length) {
    const c = src[i];
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end !== -1) {
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === "_" && src[i + 1] !== "_") {
      const end = src.indexOf("_", i + 1);
      if (end !== -1) {
        out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close !== -1 && src[close + 1] === "(") {
        const pend = src.indexOf(")", close + 2);
        if (pend !== -1) {
          const href = src.slice(close + 2, pend);
          out.push({ t: "link", href, c: parseInline(src.slice(i + 1, close)) });
          i = pend + 1;
          continue;
        }
      }
    }
    // 找下一个特殊字符，一次性吞普通文本
    let j = i;
    while (j < src.length && !"`*_[".includes(src[j])) j++;
    if (j > i) { pushText(src.slice(i, j)); i = j; continue; }
    pushText(c);
    i++;
  }
  return out;
}

function renderInline(nodes: Node[], keyBase = "i"): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${keyBase}-${i}`;
    switch (n.t) {
      case "text": return <span key={k}>{n.v}</span>;
      case "code": return <code key={k} className="md-code">{n.v}</code>;
      case "b": return <strong key={k}>{renderInline(n.c, k)}</strong>;
      case "i": return <em key={k}>{renderInline(n.c, k)}</em>;
      case "link": return <a key={k} className="md-link" href={n.href} target="_blank" rel="noreferrer noopener">{renderInline(n.c, k)}</a>;
    }
  });
}

/** 单行块类型判定 → 渲染 */
function renderLine(line: string, key: number): ReactNode {
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    const lv = h[1].length;
    const body = renderInline(parseInline(h[2]), "h");
    if (lv === 1) return <h2 key={key} className="md-h">{body}</h2>;
    if (lv === 2) return <h3 key={key} className="md-h">{body}</h3>;
    return <h4 key={key} className="md-h">{body}</h4>;
  }
  const ul = line.match(/^\s*[-*+]\s+(.*)$/);
  if (ul) return <li key={key} className="md-li">{renderInline(parseInline(ul[1]))}</li>;
  const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
  if (ol) return <li key={key} className="md-li">{renderInline(parseInline(ol[1]))}</li>;
  return <p key={key} className="md-p">{renderInline(parseInline(line))}</p>;
}

/** GFM 表格：分隔行判定（如 |---|:--:|---:|），只含 | - : 空格且至少一段 dash */
function isDelimRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-")) return false;
  if (!/^[\s|:-]+$/.test(t)) return false;
  return /:?-+:?/.test(t);
}
/** 拆表格行的单元格：去掉首尾 |，按 | 切，trim */
function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim().replace(/\\\|/g, "|"));
}
/** 由分隔单元格推对齐：:-- 左 / --: 右 / :-: 中 / --- 左 */
function cellAlign(delim: string | undefined): "left" | "right" | "center" {
  const c = (delim ?? "").trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** 轻量 Markdown 渲染：代码块 + 标题 + 列表 + 表格 + 加粗/斜体/行内代码/链接 */
export default function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let listBuf: { kind: "ul" | "ol"; items: ReactNode[]; key: number } | null = null;
  const flushList = () => {
    if (listBuf) {
      const { kind, items, key } = listBuf;
      blocks.push(kind === "ul" ? <ul key={key} className="md-list">{items}</ul> : <ol key={key} className="md-list">{items}</ol>);
      listBuf = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (line.trimStart().startsWith("```")) {
      flushList();
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      const codeText = buf.join("\n");
      blocks.push(
        <div key={`c${i}`} className="md-pre-wrap">
          <pre className="md-pre">
            {lang && <span className="md-pre-lang">{lang}</span>}
            <code>{codeText}</code>
          </pre>
          <CopyButton value={codeText} layout="overlay" className="md-pre-copy" tooltip="复制代码" />
        </div>
      );
      continue;
    }
    // 空行：结束列表，产生一个小间距（直接忽略即可，p 自带 margin）
    if (line.trim() === "") {
      flushList();
      i++;
      continue;
    }
    // 表格：当前行是表头，下一行是分隔行（--- / :--: / ---:）
    if (line.includes("|") && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      flushList();
      const header = splitCells(line);
      const aligns = splitCells(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`t${i}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, ci) => (
                  <th key={ci} style={{ textAlign: aligns[ci] ?? "left" }}>{renderInline(parseInline(h), "th")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] ?? "left" }}>{renderInline(parseInline(r[ci] ?? ""), `td${ri}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    // 列表项
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const kind = /^\s*[-*+]\s+/.test(line) ? "ul" : "ol";
      if (!listBuf || listBuf.kind !== kind) {
        flushList();
        listBuf = { kind, items: [], key: i };
      }
      listBuf.items.push(renderLine(line, i));
      i++;
      continue;
    }
    // 普通段落：连续非空行合并成一个段落（遇到代码块/列表/表格起始则停止）
    flushList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isDelimRow(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={`p${i}`} className="md-p">{renderInline(parseInline(para.join("\n")))}</p>);
  }
  flushList();
  return <div className="md">{blocks}</div>;
}