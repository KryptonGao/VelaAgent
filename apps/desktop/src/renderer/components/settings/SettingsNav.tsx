import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useAutoHideScrollbar } from "../../hooks/useAutoHideScrollbar";
import type { SettingsCopy } from "../settings-copy";
import { CloseIcon, SearchIcon } from "../icons";
import { groupOfPage, settingsGroups, type SettingsPageId } from "./settings-registry";
import type { SettingsSearchResult } from "./settings-search";

interface SettingsNavProps {
  copy: SettingsCopy;
  page: SettingsPageId;
  /** 当前构建里可用的页面(开发工具页只在开发版出现)。 */
  pages: readonly SettingsPageId[];
  onPage: (page: SettingsPageId) => void;
  query: string;
  onQuery: (query: string) => void;
  results: SettingsSearchResult[];
  onPick: (result: SettingsSearchResult) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function SettingsNav({ copy, page, pages, onPage, query, onQuery, results, onPick, searchRef }: SettingsNavProps) {
  const listId = useId();
  const navRef = useRef<HTMLElement>(null);
  useAutoHideScrollbar(navRef);
  const searching = query.trim().length > 0;
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <nav className="settings-nav autohide-scrollbar" ref={navRef} aria-label={copy.title}>
      <div className="settings-search">
        <SearchIcon size={14} />
        <input
          ref={searchRef}
          className="settings-search-input"
          type="text"
          role="combobox"
          aria-label={copy.search.label}
          aria-expanded={searching}
          aria-controls={searching ? listId : undefined}
          aria-activedescendant={searching && results.length > 0 ? optionId(active) : undefined}
          placeholder={copy.search.placeholder}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              if (query) {
                event.preventDefault();
                onQuery("");
              }
              return;
            }
            if (!searching || results.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => (index + 1) % results.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (index - 1 + results.length) % results.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              onPick(results[Math.min(active, results.length - 1)]);
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="settings-search-clear"
            aria-label={copy.search.clear}
            title={copy.search.clear}
            onClick={() => {
              onQuery("");
              searchRef.current?.focus();
            }}
          >
            <CloseIcon size={12} />
          </button>
        ) : null}
      </div>

      {searching ? (
        results.length === 0 ? (
          <p className="settings-search-empty" role="status">{copy.search.empty}</p>
        ) : (
          <div className="settings-search-results" id={listId} role="listbox" aria-label={copy.search.results}>
            {results.map((result, index) => {
              const group = groupOfPage(result.entry.page);
              return (
                <button
                  key={result.entry.id}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  className={`settings-search-result${index === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onPick(result)}
                >
                  <span className="settings-search-result-title">{result.entry.title}</span>
                  <span className="settings-search-result-path">
                    {copy.groups[group]} › {result.entry.pageLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )
      ) : (
        settingsGroups.map((group) => {
          const items = group.pages.filter((id) => pages.includes(id));
          if (items.length === 0) return null;
          return (
            <div className="settings-nav-group" key={group.id} role="group" aria-label={copy.groups[group.id]}>
              <div className="settings-nav-group-label" aria-hidden="true">{copy.groups[group.id]}</div>
              {items.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-nav-item${page === id ? " active" : ""}`}
                  aria-current={page === id ? "page" : undefined}
                  onClick={() => onPage(id)}
                >
                  {copy.pages[id].label}
                </button>
              ))}
            </div>
          );
        })
      )}
    </nav>
  );
}
