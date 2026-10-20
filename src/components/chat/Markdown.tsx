import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import styles from "./Markdown.module.css";

// Renders assistant markdown: headings, lists, tables, links, inline code and
// fenced code blocks (which get a copy button). Links open in a new tab safely.
//
// With `words`, every word of prose is wrapped in <span data-w="n">, numbered
// in reading order, so a streaming reply can dust in the words that just
// arrived. Code is left whole: CodeBlock needs its text untouched.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function rehypeWordSpans() {
  return (tree: HastNode) => {
    let n = 0;
    const visit = (node: HastNode) => {
      if (!node.children || node.tagName === "pre" || node.tagName === "code") return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          visit(child);
          next.push(child);
          continue;
        }
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) next.push({ type: "text", value: part });
          else next.push({ type: "element", tagName: "span", properties: { dataW: n++ }, children: [{ type: "text", value: part }] });
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}

export function Markdown({ content, words = false }: { content: string; words?: boolean }) {
  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={words ? [rehypeWordSpans] : []}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const text = String(children).replace(/\n$/, "");
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            if (lang || text.includes("\n")) return <CodeBlock code={text} language={lang} />;
            return <code className={styles.inline}>{children}</code>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
