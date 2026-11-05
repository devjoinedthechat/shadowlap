import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { PAUSED } from '../connection.js';
import { closeMenu, shownMenu } from '../overlays/menu-store.js';
import { useApp } from '../state.js';
import { tipCard } from './HoverCard.js';

/**
 * What every action on the server is drawn with. It keeps its place and its focus while it can't run:
 * read-only or an exported copy (`actionsOff`), the server out of reach, or the page's own reason
 * (`why`), the first that applies. It reads plain then: `aria-disabled`, half strength, never lime or
 * red, its own title gone so that its card alone says why, in full where `whyTip` has more to say. A
 * press says why in a toast, which offers `whyAct` as the way out, and from the keyboard gives it the
 * focus. A plain `disabled` is for what isn't waiting on anything, and wins over every reason.
 */

/** Why an action can't run now, or null: for what isn't a button (a form's submit, a palette's row, a dialog's confirm). */
export function useActionWait(why?: string | null): string | null {
  const { actionsOff, conn } = useApp();
  return actionsOff ?? (conn === 'offline' ? PAUSED : null) ?? why ?? null;
}

/**
 * A link to an attempt, which no list the page holds has: it can't open while the server is out of
 * reach, though a link to anything else still can. What to give its `onClick`.
 */
export function useOfflineLink(): (e: MouseEvent<HTMLElement>) => void {
  const { conn, toast } = useApp();
  return (e) => {
    if (conn !== 'offline') return;
    e.preventDefault();
    e.stopPropagation();
    toast(PAUSED);
  };
}

/** A way out of what holds a control, offered in the toast a press raises. */
export interface WhyAct {
  label: string;
  run: () => void;
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>;

export interface ActionButtonProps extends ButtonProps {
  /** The page's own reason it can't run. */
  why?: string | null | undefined;
  whyAct?: WhyAct | undefined;
  /** More than the toast's line, for its card. */
  whyTip?: string | undefined;
  /** Its card: a title, a line under it and the command it runs. */
  tip?: string | undefined;
  sub?: string | null | undefined;
  command?: string | undefined;
  /** A link while it can run; a button while it waits. */
  href?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
  onClick?: ((e: MouseEvent<HTMLElement>) => void) | undefined;
}

/** A control's words, for its card's title. */
function wordsOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return Array.isArray(node) ? node.map(wordsOf).join('') : '';
}

export function ActionButton({ why, whyAct, whyTip, tip, sub, command, href, onClick, className = '', title, disabled, children, ref, type = 'button', ...rest }: ActionButtonProps) {
  const { toast } = useApp();
  const reason = useActionWait(why);
  if (reason && !disabled) {
    const press = (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const keyboard = e.detail === 0;
      const menu = shownMenu();
      const inMenu = !!whyAct && keyboard && !!menu?.root.contains(e.currentTarget);
      const from = inMenu ? menu!.opener.el : e.currentTarget;
      if (inMenu) closeMenu(true);
      toast(reason, 'notice', whyAct ? { ...whyAct, returnTo: from, focus: keyboard } : undefined);
    };
    const plain = className.replace(/\b(lime|danger)\b/g, '').replace(/\s+/g, ' ').trim();
    const card = tipCard(tip ?? rest['aria-label'] ?? title ?? wordsOf(children), [], whyTip ?? reason, command);
    return (
      <button {...rest} ref={ref} type={type} className={plain} aria-disabled="true" data-why={reason} data-tip={card} onClick={press}>
        {children}
      </button>
    );
  }
  const data = tip ? { 'data-tip': tipCard(tip, [], sub, command) } : {};
  if (href && !disabled) {
    return (
      <a {...(rest as object)} {...data} className={className} href={href} title={title} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <button {...rest} {...data} ref={ref} type={type} className={className} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}
