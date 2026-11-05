import { focusPage } from '../focus-manager.js';

/**
 * Skip to content: the first stop for Tab on every page, out of sight until it has the focus. It
 * moves the focus past the top bar and the sidebar to the page's heading (with none, its scrolling
 * pane, so the arrow keys scroll it), and the next Tab reaches the page's own first control.
 */
export function SkipLink() {
  return (
    <a
      className="skip"
      href="#view"
      onClick={(e) => {
        // The page's routes live after the #: the link moves the focus, never the route.
        e.preventDefault();
        focusPage();
      }}
    >
      Skip to content
    </a>
  );
}
