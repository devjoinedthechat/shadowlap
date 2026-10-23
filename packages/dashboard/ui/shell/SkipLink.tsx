/**
 * Skip to the page: the first stop for Tab on every page, out of sight until it has the focus. It
 * moves the focus past the top bar and the sidebar to the page itself (its scrolling pane where it
 * has one, so the arrow keys scroll it), and the next Tab reaches the page's own first control.
 */
export function SkipLink() {
  return (
    <a
      className="skip"
      href="#view"
      onClick={(e) => {
        // The page's routes live after the #: the link moves the focus, never the route.
        e.preventDefault();
        skipToPage();
      }}
    >
      Skip to the page
    </a>
  );
}

/** Moves the focus to the page: its scrolling pane, else the main region that holds it. */
export function skipToPage(): void {
  const main = document.querySelector<HTMLElement>('#view');
  if (!main) return;
  const pane = [...main.children].find((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('page'));
  (pane ?? main).focus();
}
