import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Modal } from "./Modal";

const docsRaw = import.meta.glob("../../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface DocEntry {
  key: string;
  relPath: string;
  group: string;
  filename: string;
  title: string;
  content: string;
}

interface DocGroup {
  id: string;
  label: string;
  description?: string;
  entries: DocEntry[];
}

const GROUP_META: Record<string, { label: string; description: string; order: number }> = {
  ".": {
    label: "Overview",
    description: "Top-level index for the documentation.",
    order: 0,
  },
  "internal/lunarlib-and-IT": {
    label: "Lunalib & IT",
    description: "Parser internals, IGHW format, with InsomniaToolset cross-references.",
    order: 1,
  },
  "internal/app": {
    label: "App",
    description: "Tauri 2 + React + Three.js desktop app.",
    order: 2,
  },
  "public": {
    label: "End-user (in development)",
    description: "Non-technical, plain-language guides. Coming soon.",
    order: 3,
  },
  internal: {
    label: "Internal misc",
    description: "Older notes kept for historical context.",
    order: 4,
  },
};

function relPathOf(absKey: string): string {
  const idx = absKey.indexOf("/docs/");
  if (idx < 0) return absKey;
  return absKey.slice(idx + "/docs/".length);
}

function titleFromMarkdown(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || fallback;
}

function groupOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "." : rel.slice(0, slash);
}

function buildEntries(): DocGroup[] {
  const entries: DocEntry[] = Object.entries(docsRaw).map(([key, content]) => {
    const rel = relPathOf(key);
    const slash = rel.lastIndexOf("/");
    const filename = slash < 0 ? rel : rel.slice(slash + 1);
    const group = groupOf(rel);
    return {
      key,
      relPath: rel,
      group,
      filename,
      title: titleFromMarkdown(content, filename),
      content,
    };
  });

  const grouped = new Map<string, DocEntry[]>();
  for (const e of entries) {
    const arr = grouped.get(e.group) ?? [];
    arr.push(e);
    grouped.set(e.group, arr);
  }

  const groups: DocGroup[] = [];
  for (const [id, arr] of grouped.entries()) {
    arr.sort((a, b) => a.filename.localeCompare(b.filename));
    const meta = GROUP_META[id] ?? { label: id, description: "", order: 99 };
    groups.push({
      id,
      label: meta.label,
      description: meta.description,
      entries: arr,
    });
  }
  groups.sort((a, b) => {
    const ao = GROUP_META[a.id]?.order ?? 99;
    const bo = GROUP_META[b.id]?.order ?? 99;
    return ao - bo;
  });
  return groups;
}

interface DocsModalProps {
  open: boolean;
  onClose: () => void;
}

export function DocsModal({ open, onClose }: DocsModalProps) {
  const groups = useMemo(buildEntries, []);
  const allEntries = useMemo(
    () => groups.flatMap((g) => g.entries),
    [groups],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    if (!activeKey && allEntries.length > 0) {
      const home = allEntries.find((e) => e.relPath === "README.md");
      setActiveKey(home?.key ?? allEntries[0]!.key);
    }
  }, [open, activeKey, allEntries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        entries: g.entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.relPath.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.entries.length > 0);
  }, [groups, query]);

  const active = activeKey
    ? allEntries.find((e) => e.key === activeKey)
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Documentation"
      subtitle={
        <span className="dim small">
          {allEntries.length} markdown files bundled with the app
        </span>
      }
      size="xl"
    >
      <div className="docs-modal-shell">
        <aside className="docs-modal-sidebar">
          <input
            type="search"
            className="docs-modal-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <nav className="docs-modal-nav">
            {filtered.length === 0 && (
              <div className="dim small docs-modal-empty">No matches.</div>
            )}
            {filtered.map((g) => (
              <section key={g.id} className="docs-modal-group">
                <header className="docs-modal-group-header">
                  <strong className="small">{g.label}</strong>
                  {g.description && (
                    <span className="dim small">{g.description}</span>
                  )}
                </header>
                <ul className="docs-modal-entries">
                  {g.entries.map((e) => (
                    <li key={e.key}>
                      <button
                        type="button"
                        className={`docs-modal-entry${e.key === activeKey ? " is-active" : ""}`}
                        onClick={() => setActiveKey(e.key)}
                        title={e.relPath}
                      >
                        <span className="docs-modal-entry-title">{e.title}</span>
                        <span className="docs-modal-entry-path mono small dim">
                          {e.filename}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        </aside>
        <article className="docs-modal-body">
          {active ? (
            <>
              <div className="docs-modal-breadcrumb mono small dim">
                docs / {active.relPath}
              </div>
              <div className="docs-modal-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {active.content}
                </ReactMarkdown>
              </div>
            </>
          ) : (
            <div className="docs-modal-empty dim">
              Pick a document on the left.
            </div>
          )}
        </article>
      </div>
    </Modal>
  );
}
