import { tipCard } from './HoverCard.js';

/** A chip a dialog picks with: its id, and its title and text for the card on hover. */
export interface ToggleChip {
  id: string;
  title?: string | undefined;
  text?: string | undefined;
}

/**
 * The chips a dialog picks what runs with (an injection test's templates, the error-path presets):
 * each a toggle (`aria-pressed`), on in ink on the raised fill and off struck through, never lime,
 * which stays the dialog's one primary button. The group is named by its head (`labelledBy`). A
 * press keeps the focus on its chip, as a toggle does; the order is the list's, whatever is picked.
 */
export function ToggleChips({ chips, picked, onToggle, labelledBy }: { chips: readonly ToggleChip[]; picked: readonly string[]; onToggle: (id: string) => void; labelledBy: string }) {
  return (
    <div className="chips togchips" role="group" aria-labelledby={labelledBy}>
      {chips.map((c) => (
        <button key={c.id} type="button" aria-pressed={picked.includes(c.id)} {...(c.title ? { 'data-tip': tipCard(c.title, [], c.text) } : {})} onClick={() => onToggle(c.id)}>
          {c.id}
        </button>
      ))}
    </div>
  );
}

/** What a toggle leaves picked, in the chips' own order: the chip taken out, or put back in its place. */
export function toggled(order: readonly string[], picked: readonly string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((x) => x !== id) : order.filter((x) => x === id || picked.includes(x));
}
