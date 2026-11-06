/**
 * The icon sprite and the logo. The sprite is drawn once by the app (no inline style: the page's
 * Content-Security-Policy allows no style attributes in markup) and every icon is a `<use>` of it,
 * in the dashboard and in an exported copy alike.
 */

export type IconName =
  | 'search'
  | 'caret'
  | 'up'
  | 'down'
  | 'x'
  | 'menu'
  | 'play'
  | 'pause'
  | 'replay'
  | 'fork'
  | 'home'
  | 'runs'
  | 'compare'
  | 'tests'
  | 'gear'
  | 'folder'
  | 'copy'
  | 'plus'
  | 'help'
  | 'keys'
  | 'share'
  | 'import'
  | 'clock'
  | 'bell'
  | 'loop'
  | 'target'
  | 'check'
  | 'more';

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The lime tile and the lowercase wordmark, as the top bar shows them. */
export function Brand() {
  return (
    <>
      <svg className="tile" aria-hidden="true">
        <use href="#tile" />
      </svg>
      <svg className="word" viewBox="0 0 884 126" aria-hidden="true">
        <use href="#word" width="884" height="126" />
      </svg>
    </>
  );
}

export function Tile({ className = 'tile' }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href="#tile" />
    </svg>
  );
}

const S = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function Sprite() {
  return (
    <svg className="sprite" width="0" height="0" aria-hidden="true" focusable="false">
      <symbol id="tile" viewBox="0 0 300 300">
        <rect width="300" height="300" rx="68" fill="#c4f233" />
        <g transform="translate(150 150) scale(0.64) translate(-149.5 -150)" fill="none" strokeWidth="46">
          <path stroke="#86ad12" d="M136 70A80 80 0 0 1 216 150" />
          <path stroke="#15140f" d="M216 150A80 80 0 1 1 136 70H266" />
        </g>
      </symbol>
      <symbol id="word" viewBox="336 96 884 126">
        <path fill="currentColor" d={WORDMARK} />
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </symbol>
      <symbol id="i-caret" viewBox="0 0 10 10">
        <path d="M2 3.5l3 3 3-3" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-up" viewBox="0 0 16 16">
        <path d="M4 10l4-4 4 4" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-down" viewBox="0 0 16 16">
        <path d="M4 6l4 4 4-4" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 16 16">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 16 16">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </symbol>
      <symbol id="i-menu" viewBox="0 0 16 16">
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 16 16">
        <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />
      </symbol>
      <symbol id="i-pause" viewBox="0 0 16 16">
        <path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" fill="currentColor" />
      </symbol>
      <symbol id="i-replay" viewBox="0 0 16 16">
        <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-fork" viewBox="0 0 16 16">
        <path d="M5 2.5v4.5a3 3 0 0 0 3 3h3M11 2.5v11M8.5 7.5L11 10l-2.5 2.5" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-home" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="i-runs" viewBox="0 0 16 16">
        <path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="2.8" cy="4" r="1" fill="currentColor" />
        <circle cx="2.8" cy="8" r="1" fill="currentColor" />
        <circle cx="2.8" cy="12" r="1" fill="currentColor" />
      </symbol>
      <symbol id="i-compare" viewBox="0 0 16 16">
        <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" {...S} strokeWidth="1.4" />
      </symbol>
      <symbol id="i-tests" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.3 8.2l1.8 1.8 3.6-3.8" {...S} strokeWidth="1.5" />
      </symbol>
      <symbol id="i-gear" viewBox="0 0 16 16">
        <path d="M2.5 4.5h6M11.5 4.5h2M2.5 8h2M7.5 8h6M2.5 11.5h7M12.5 11.5h1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="10" cy="4.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11" cy="11.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="i-folder" viewBox="0 0 16 16">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 16 16">
        <rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.5 3.5v-.2A1.3 1.3 0 0 0 9.2 2H3.8A1.3 1.3 0 0 0 2.5 3.3v5.4a1.3 1.3 0 0 0 1.3 1.3h.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 16 16">
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </symbol>
      <symbol id="i-help" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.3 6.4a1.75 1.75 0 1 1 2.6 1.5c-.55.3-.9.7-.9 1.3v.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r=".85" fill="currentColor" />
      </symbol>
      <symbol id="i-keys" viewBox="0 0 16 16">
        <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </symbol>
      <symbol id="i-share" viewBox="0 0 16 16">
        <path d="M8 10V2.5M5 5.2L8 2.3l3 2.9M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4" {...S} strokeWidth="1.4" />
      </symbol>
      <symbol id="i-import" viewBox="0 0 16 16">
        <path d="M8 2.5V10M5 7.1L8 10l3-2.9M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4" {...S} strokeWidth="1.4" />
      </symbol>
      <symbol id="i-clock" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 5v3.2l2.1 1.4" {...S} strokeWidth="1.4" />
      </symbol>
      <symbol id="i-bell" viewBox="0 0 16 16">
        <path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1.2 1.2H2.8zM6.6 13.8a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
      </symbol>
      <symbol id="i-loop" viewBox="0 0 16 16">
        <path d="M11.2 8a3.6 3.6 0 1 1-3.6-3.6h6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </symbol>
      <symbol id="i-target" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="i-more" viewBox="0 0 16 16">
        <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
        <circle cx="8" cy="8" r="1.25" fill="currentColor" />
        <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
      </symbol>
    </svg>
  );
}

/** The lowercase "shadowlap" wordmark, set in Unbounded and outlined. */
const WORDMARK =
  'M427.9 174.2Q427.9 182.6 422.8 188.4Q417.7 194.2 408.2 197.1Q398.7 200 385.4 200Q371.7 200 361.4 196.7Q351.1 193.4 345.3 187.4Q339.6 181.4 339.2 173.4H365.7Q366.6 176.4 369.2 178.5Q371.8 180.6 376.2 181.7Q380.5 182.8 386.6 182.8Q394.4 182.8 398.4 181.2Q402.4 179.7 402.4 176.6Q402.4 174.2 399.4 173Q396.3 171.8 388.9 171.1L375.9 170.1Q363 169.2 355.4 166.2Q347.8 163.2 344.4 158.4Q341.1 153.6 341.1 147.4Q341.1 139.1 346.3 133.7Q351.5 128.2 360.8 125.5Q370 122.7 382.5 122.7Q394.8 122.7 404.4 125.9Q414 129.1 419.7 134.8Q425.5 140.5 426.4 148.2H399.9Q399.2 145.8 397.1 143.8Q394.9 141.8 391 140.5Q387.2 139.2 381.2 139.2Q374.1 139.2 370.5 140.8Q366.8 142.3 366.8 145.1Q366.8 147.3 369.1 148.6Q371.3 149.9 377.5 150.4L394.5 151.7Q407.2 152.4 414.5 155.3Q421.8 158.2 424.8 162.9Q427.9 167.7 427.9 174.2ZM437 99.4H463.2V198H437ZM490 122.7Q500.6 122.7 508 127Q515.3 131.2 519.3 138.9Q523.3 146.5 523.3 157V198H497V160.9Q497 152.7 492.9 148.3Q488.7 144 480.9 144Q475.5 144 471.5 146.3Q467.5 148.6 465.3 152.8Q463.2 157 463.2 162.8L455 158.6Q456.6 146.9 461.6 138.9Q466.6 130.9 473.9 126.8Q481.3 122.7 490 122.7ZM600.8 198 597.5 171.6 601 161.5 597.5 151.4 600.8 124.9H628L623.4 161.4L628 198ZM607 161.5Q605.2 173 599.9 181.7Q594.6 190.4 586.4 195.2Q578.3 200 567.9 200Q557.2 200 549.1 195.2Q540.9 190.4 536.3 181.7Q531.7 172.9 531.7 161.5Q531.7 149.9 536.3 141.2Q540.9 132.5 549.1 127.6Q557.2 122.7 567.9 122.7Q578.3 122.7 586.4 127.5Q594.6 132.3 599.9 141Q605.3 149.6 607 161.5ZM558.2 161.5Q558.2 166.9 560.4 171.1Q562.7 175.3 566.7 177.7Q570.6 180.1 575.7 180.1Q581.1 180.1 585.9 177.7Q590.6 175.3 594.2 171.1Q597.8 166.9 599.6 161.5Q597.8 156 594.2 151.8Q590.6 147.6 585.9 145.1Q581.1 142.7 575.7 142.7Q570.6 142.7 566.7 145.1Q562.7 147.6 560.4 151.8Q558.2 156 558.2 161.5ZM704.6 198 701.2 170.6 705.7 161.6 701.3 150.4 707.5 99.4H734.6L727 159.5L731.6 198ZM710.3 161.5Q708.5 173 703.2 181.7Q697.9 190.4 689.7 195.2Q681.6 200 671.2 200Q660.5 200 652.4 195.2Q644.2 190.4 639.6 181.7Q635 172.9 635 161.5Q635 149.9 639.6 141.2Q644.2 132.5 652.4 127.6Q660.5 122.7 671.2 122.7Q681.6 122.7 689.7 127.5Q697.9 132.3 703.2 141Q708.6 149.6 710.3 161.5ZM661.5 161.5Q661.5 166.9 663.7 171.1Q666 175.3 670 177.7Q673.9 180.1 679 180.1Q684.4 180.1 689.2 177.7Q693.9 175.3 697.5 171.1Q701.1 166.9 702.8 161.5Q701.1 156 697.5 151.8Q693.9 147.6 689.2 145.1Q684.4 142.7 679 142.7Q673.9 142.7 670 145.1Q666 147.6 663.7 151.8Q661.5 156 661.5 161.5ZM785.2 200Q771.1 200 760.6 195.2Q750.1 190.4 744.2 181.7Q738.3 172.9 738.3 161.5Q738.3 149.9 744.2 141.2Q750.1 132.5 760.6 127.6Q771.1 122.7 785.2 122.7Q799.1 122.7 809.7 127.6Q820.2 132.5 826.1 141.2Q832 149.9 832 161.5Q832 172.9 826.1 181.7Q820.2 190.4 809.7 195.2Q799.1 200 785.2 200ZM785.2 180.7Q791.6 180.7 796.1 178.4Q800.6 176.1 803.1 171.8Q805.5 167.4 805.5 161.5Q805.5 155.4 803.1 151.1Q800.6 146.8 796.1 144.5Q791.6 142.2 785.2 142.2Q778.8 142.2 774.1 144.5Q769.5 146.8 767.1 151.1Q764.7 155.4 764.7 161.4Q764.7 167.4 767.1 171.8Q769.5 176.1 774.1 178.4Q778.8 180.7 785.2 180.7ZM938 183.3H929.8L950.5 124.9H976.6L949.2 198H922.6L899.7 137.3H908.4L885.2 198H858.6L831.2 124.9H857.6L878.2 183.3H870L891.6 124.9H916.6ZM982.1 99.4H1008.4V198H982.1ZM1086.8 198 1083.5 171.6 1087 161.5 1083.5 151.4 1086.8 124.9H1114L1109.4 161.4L1114 198ZM1093 161.5Q1091.2 173 1085.9 181.7Q1080.6 190.4 1072.4 195.2Q1064.3 200 1054 200Q1043.2 200 1035.1 195.2Q1026.9 190.4 1022.3 181.7Q1017.7 172.9 1017.7 161.5Q1017.7 149.9 1022.3 141.2Q1026.9 132.5 1035.1 127.6Q1043.2 122.7 1054 122.7Q1064.3 122.7 1072.4 127.5Q1080.6 132.3 1086 141Q1091.3 149.6 1093 161.5ZM1044.2 161.5Q1044.2 166.9 1046.5 171.1Q1048.7 175.3 1052.7 177.7Q1056.6 180.1 1061.8 180.1Q1067.1 180.1 1071.9 177.7Q1076.6 175.3 1080.2 171.1Q1083.8 166.9 1085.6 161.5Q1083.8 156 1080.2 151.8Q1076.6 147.6 1071.9 145.1Q1067.1 142.7 1061.8 142.7Q1056.6 142.7 1052.7 145.1Q1048.7 147.6 1046.5 151.8Q1044.2 156 1044.2 161.5ZM1124.6 124.9H1150.8V145.9L1149.7 149V169.5L1150.8 175.5V219.1H1124.6ZM1142.5 161.5Q1144.2 149.6 1149.5 141Q1154.8 132.3 1163 127.5Q1171.2 122.7 1181.6 122.7Q1192.3 122.7 1200.4 127.6Q1208.6 132.5 1213.1 141.2Q1217.7 149.9 1217.7 161.5Q1217.7 172.9 1213.1 181.7Q1208.6 190.4 1200.4 195.2Q1192.3 200 1181.6 200Q1171.2 200 1163 195.2Q1154.8 190.4 1149.6 181.7Q1144.3 173 1142.5 161.5ZM1191.3 161.5Q1191.3 156 1189.1 151.8Q1186.8 147.6 1182.8 145.1Q1178.8 142.7 1173.6 142.7Q1168.4 142.7 1163.6 145.1Q1158.9 147.6 1155.3 151.8Q1151.7 156 1149.8 161.5Q1151.7 166.9 1155.3 171.1Q1158.9 175.3 1163.6 177.7Q1168.4 180.1 1173.6 180.1Q1178.8 180.1 1182.8 177.7Q1186.8 175.3 1189.1 171.1Q1191.3 166.9 1191.3 161.5Z';
