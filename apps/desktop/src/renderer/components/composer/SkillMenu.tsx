import type { SkillSummary } from "@vela/shared";
import { useEffect, useRef } from "react";
import { CloseIcon, SkillIcon } from "../icons";
import { skillOriginLabel, skillTitle } from "./skill-picker";

export function SkillToken({
  name,
  description,
  onRemove,
}: {
  name: string;
  description?: string;
  onRemove?: () => void;
}) {
  return (
    <div className="composer-skill" title={description || `/skill:${name}`}>
      <SkillIcon size={15} />
      <span className="composer-skill-name">{skillTitle(name)}</span>
      {onRemove ? (
        <button type="button" className="composer-skill-remove" aria-label="移除 Skill" onClick={onRemove}>
          <CloseIcon size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function SkillMenu({
  skills,
  error,
  query,
  activeIndex,
  onActiveIndex,
  onSelect,
}: {
  skills: SkillSummary[] | null;
  error: string | null;
  query: string;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (skill: SkillSummary) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const row = activeRef.current;
    const list = listRef.current;
    if (!row || !list) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, skills]);

  const empty = skills === null && !error
    ? "正在读取 Skill…"
    : error && !query
      ? error
      : query
        ? "没有匹配的 Skill"
        : "还没有 Skill";

  return (
    <div className="skill-menu" id="skill-menu" role="listbox" aria-label="技能" onMouseDown={(event) => event.preventDefault()}>
      <div className="skill-menu-title">技能</div>
      {skills && skills.length > 0 ? (
        <div className="skill-menu-list" ref={listRef}>
          {skills.map((skill, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={skill.location}
                id={`skill-option-${index}`}
                ref={selected ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                className={`skill-menu-row${selected ? " active" : ""}`}
                onMouseEnter={() => onActiveIndex(index)}
                onClick={() => onSelect(skill)}
              >
                <span className="skill-menu-icon">
                  <SkillIcon size={15} />
                </span>
                <span className="skill-menu-name">{skillTitle(skill.name)}</span>
                <span className="skill-menu-desc">{skill.description}</span>
                <span className="skill-menu-origin">{skillOriginLabel(skill.origin)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="skill-menu-empty">{empty}</div>
      )}
    </div>
  );
}
