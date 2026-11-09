import { useApp } from '../state.js';
import { pressBilled, tipEst, type BilledPress, type Priced } from '../spending.js';
import { ActionButton, type ActionButtonProps } from './ActionButton.js';

export { tipEst };

/**
 * The button every billed job starts from. Its card says the job's estimate under its sentence, and
 * whether it starts at once or asks first as Spending stands when the card shows. A press follows the
 * one rule (`pressBilled`): at or under the threshold it starts, sending the estimate it showed so the
 * drawer says the same; above it, with no estimate, for a job that asks for what it does, or for a
 * form, it opens its ask. Until the threshold is known it asks. A control that bills nothing has no
 * `estimate` and is no form (or has `bills={false}`): no line, and a press starts it. It waits as every action does
 * (ActionButton), its card then saying the amount alone.
 */
export interface JobButtonProps extends Omit<ActionButtonProps, 'onClick' | 'est' | 'form'> {
  /** What the job bills: an estimate, null for none (it always asks), undefined while it is worked out (it asks). */
  estimate?: Priced;
  /** False for a control that bills nothing, whatever `estimate` says. */
  bills?: boolean | undefined;
  /** It opens a dialog that asks what to run: it asks on every setting, and its card says the amount alone. */
  form?: boolean | undefined;
  /** Starts the job, with the estimate's fields for the start's body. */
  start: BilledPress['start'];
  /** Opens its ask, or its form. */
  ask: () => void;
}

/** A list row's step's handlers (Needs a look): a list carries no estimate, so the step asks for its own as the pointer or the focus reaches it. */
export interface StepHooks {
  onPointerEnter: () => void;
  onFocus: () => void;
}

/** The rule a press follows, inside the app's guard as every start is: for what renders, a button or a menu's row. */
export function useBilledPress(): (p: BilledPress) => boolean {
  const { guard } = useApp();
  return (p) => guard(() => void pressBilled(p));
}


export function JobButton(props: JobButtonProps) {
  const { estimate, bills = true, form = false, start, ask, ...rest } = props;
  const { guard } = useApp();
  const press = useBilledPress();
  // A form opens on every press, priced or not; a control with neither bills nothing.
  const billed = bills && ('estimate' in props || form);
  const onClick = billed ? () => press({ estimate, form, start, ask }) : () => guard(() => start({}));
  return <ActionButton {...rest} est={billed ? tipEst(estimate, form) : null} onClick={onClick} />;
}
