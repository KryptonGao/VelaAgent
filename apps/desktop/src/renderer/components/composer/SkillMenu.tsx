import type { SkillSummary } from "@vela/shared";
import { useEffect, useRef } from "react";
import { CloseIcon, SkillIcon } from "../icons";
import { skillOriginLabel, skillTitle } from "./skill-picker";
import { localizeError, tr } from "../../locale";
import { useReducedMotion } from "../../hooks/useMotionPresence";

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
        <button type="button" className="composer-skill-remove" aria-label={tr("移除 Skill", "Remove skill")} onClick={onRemove}>
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
  const reduced = useReducedMotion();

  useEffect(() => {
    const row = activeRef.current;
    const list = listRef.current;
    if (!row || !list) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const bottom = top + row.offsetHeight;
    const target = Math.min(top, Math.max(list.scrollTop, bottom - list.clientHeight));
    // Retarget rapid key repeats, including a reversal while a scroll is active.
    list.scrollTo({ top: target, behavior: reduced ? "instant" : "smooth" });
  }, [activeIndex, skills, reduced]);

  const empty = skills === null && !error
    ? tr("正在读取 Skill…", "Loading skills…")
    : error && !query
      ? localizeError(error)
      : query
        ? tr("没有匹配的 Skill", "No matching skills")
        : tr("还没有 Skill", "No skills yet");

  return (
    <div className="skill-menu" id="skill-menu" role="listbox" aria-label={tr("技能", "Skills")} onMouseDown={(event) => event.preventDefault()}>
      <div className="skill-menu-title">{tr("技能", "Skills")}</div>
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
