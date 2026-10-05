import { Fragment, useEffect, useRef } from "react";
import { CloseIcon, FileIcon, SkillIcon } from "../icons";
import type { SlashMenuItem } from "./slash-picker";
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

export function SkillMenu({ items, loadingSkills, loadingRecipes, error, recipeError, query, activeIndex, onActiveIndex, onSelect }: {
  items: SlashMenuItem[];
  loadingSkills: boolean;
  loadingRecipes: boolean;
  error: string | null;
  recipeError: string | null;
  query: string;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (item: SlashMenuItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const row = activeRef.current, list = listRef.current;
    if (!row || !list) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const bottom = top + row.offsetHeight;
    const target = Math.min(top, Math.max(list.scrollTop, bottom - list.clientHeight));
    list.scrollTo({ top: target, behavior: reduced ? "instant" : "smooth" });
  }, [activeIndex, items, reduced]);
  const empty = loadingSkills || loadingRecipes
    ? tr("正在读取技能与任务配方…", "Loading skills and task recipes…")
    : query ? tr("没有匹配的技能或任务配方", "No matching skills or task recipes")
    : tr("还没有技能或任务配方", "No skills or task recipes yet");
  const originLabel = (origin: string) => origin === 'builtin' ? tr('内置', 'Built-in') : origin === 'project' ? tr('项目', 'Project') : origin === 'team' ? tr('团队', 'Team') : tr('个人', 'Personal');
  return <div className="skill-menu" id="skill-menu" role="listbox" aria-label={tr("技能与任务配方", "Skills and task recipes")} onMouseDown={event => event.preventDefault()}>
    <div className="skill-menu-list" ref={listRef}>
      {items.map((item, index) => {
        const selected = index === activeIndex;
        const skill = item.type === 'skill' ? item.skill : null;
        const recipe = item.type === 'recipe' ? item.recipe : null;
        return <Fragment key={skill ? `skill:${skill.location}` : `recipe:${recipe!.id}`}>
          {index === 0 || items[index - 1]!.type !== item.type ? <div className="skill-menu-title" aria-hidden="true">{skill ? tr('技能', 'Skills') : tr('任务配方', 'Task recipes')}</div> : null}
          <button id={`skill-option-${index}`} ref={selected ? activeRef : undefined} type="button" role="option" aria-selected={selected}
            aria-label={skill ? `${skillTitle(skill.name)} · ${tr('技能', 'Skill')} · ${skill.description}` : `${recipe!.name} · ${tr('任务配方', 'Task recipe')} · ${originLabel(recipe!.origin)} · ${recipe!.description}`}
            className={`skill-menu-row${selected ? " active" : ""}`} onMouseEnter={() => onActiveIndex(index)} onClick={() => onSelect(item)}>
            <span className="skill-menu-icon">{skill ? <SkillIcon size={15} /> : <FileIcon size={15} />}</span>
            <span className="skill-menu-name">{skill ? skillTitle(skill.name) : recipe!.name}</span>
            <span className="skill-menu-desc">{skill?.description ?? recipe!.description}</span>
            <span className="skill-menu-origin">{skill ? skillOriginLabel(skill.origin) : originLabel(recipe!.origin)}</span>
          </button>
        </Fragment>;
      })}
      {!items.length && <div className="skill-menu-empty" role="status">{empty}</div>}
      {error && <div className="skill-menu-empty" role="status">{tr('技能：', 'Skills: ')}{localizeError(error)}</div>}
      {recipeError && <div className="skill-menu-empty" role="status">{tr('任务配方：', 'Task recipes: ')}{localizeError(recipeError)}</div>}
    </div>
  </div>;
}
