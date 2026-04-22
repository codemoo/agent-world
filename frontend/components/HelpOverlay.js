// "?" button + shortcut legend. Single overlay listing every keyboard
// affordance in plain DOM. Both "?" and "Shift+/" trigger it so Korean
// two-bul keyboards work too. Bilingual labels.

const HELP_VERSION = 1;

const SECTIONS = [
  {
    title: 'Global · 전체',
    rows: [
      ['?',          'Show / hide this help · 도움말 열고 닫기'],
      ['1–9',        'Focus agent #N · N번째 에이전트 패널 열기'],
      ['0',          'Close session panel · 세션 패널 닫기'],
      ['Esc',        'Close panels & modals · 패널/모달 닫기'],
      ['N',          'Toggle name tags · 이름표 토글'],
      ['M',          'Toggle minimal sprite preview · 미니멀 프리뷰 토글'],
      ['E',          'Toggle world editor (needs assets) · 월드 에디터 토글 (에셋 필요)'],
      ['← →',  'Scrub timeline (bottom bar) · 타임라인 이동'],
      ['Space',      'Play / pause timeline · 타임라인 재생/정지']
    ]
  },
  {
    title: 'Agent panel · 세션 패널',
    rows: [
      ['click sprite',  'Open session details · 스프라이트 클릭 → 세부정보'],
      ['T',             'Open transcript viewer · 대화 TUI 열기'],
      ['L',             'Switch to Live PTY · Live PTY 탭'],
      ['Focus terminal','Bring the host Terminal to front · 호스트 터미널 포커스']
    ]
  },
  {
    title: 'Editor · 에디터',
    rows: [
      ['Ctrl+Z / Cmd+Z',          'Undo · 실행 취소'],
      ['Ctrl+Shift+Z / Cmd+Y',    'Redo · 다시 실행'],
      ['Ctrl+S / Cmd+S',          'Save layout · 레이아웃 저장'],
      ['Delete / Backspace',      'Remove selection · 선택 제거'],
      ['← ↑ → ↓', 'Nudge ±1 tile · 한 칸 이동'],
      ['F / Shift+F',             'Flip horizontal / vertical · 좌우/상하 반전']
    ]
  }
];

function injectStyles(doc) {
  if (doc.getElementById('help-overlay-styles')) return;
  const style = doc.createElement('style');
  style.id = 'help-overlay-styles';
  style.textContent = `
    #help-button {
      position: fixed; top: 12px; right: 312px;
      width: 30px; height: 30px;
      background: rgba(15, 23, 42, 0.88);
      color: #fbbf24;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 50%;
      font: 700 15px/1 Menlo, monospace;
      cursor: pointer; z-index: 11;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.12s ease, transform 0.12s ease;
      padding: 0;
    }
    #help-button:hover { background: rgba(56, 189, 248, 0.18); transform: scale(1.07); }
    #help-overlay {
      position: fixed; inset: 0; z-index: 25;
      background: rgba(2, 6, 23, 0.75);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center; justify-content: center;
      padding: 18px;
    }
    #help-overlay[data-open="1"] { display: flex; }
    #help-overlay .help-card {
      max-width: 640px; width: 100%;
      max-height: calc(100vh - 48px); overflow: auto;
      background: #0f172a; color: #e2e8f0;
      border: 1px solid rgba(251, 191, 36, 0.35);
      border-radius: 12px;
      padding: 22px 26px;
      font: 12px/1.55 Menlo, Monaco, monospace;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    }
    #help-overlay h2 {
      margin: 0 0 4px; font-size: 16px; color: #fbbf24;
      letter-spacing: 0.02em;
    }
    #help-overlay .help-sub {
      color: #94a3b8; font-size: 11px; margin-bottom: 16px;
    }
    #help-overlay h3 {
      font-size: 12px; color: #38bdf8;
      margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.06em;
    }
    #help-overlay dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 14px;
      margin: 0;
    }
    #help-overlay dt {
      color: #fbbf24;
      font-weight: 600;
      white-space: nowrap;
      padding: 2px 6px;
      background: rgba(251, 191, 36, 0.08);
      border-radius: 4px;
      align-self: start;
    }
    #help-overlay dd {
      margin: 0;
      color: #cbd5e1;
      align-self: center;
    }
    #help-overlay .help-close {
      position: sticky; top: -22px;
      float: right;
      background: none; border: none; color: #94a3b8;
      font: 14px/1 Menlo, monospace; cursor: pointer;
      padding: 0 4px;
    }
    #help-overlay .help-footer {
      margin-top: 18px; padding-top: 10px;
      border-top: 1px solid rgba(148, 163, 184, 0.18);
      color: #64748b; font-size: 10px;
      display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
  `;
  doc.head.appendChild(style);
}

export default class HelpOverlay {
  constructor({ document: doc = document, window: win = window } = {}) {
    this.document = doc;
    this.window = win;
    this.isOpen = false;
    console.log(`[HelpOverlay v${HELP_VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
  }

  _build() {
    const doc = this.document;
    this.button = doc.createElement('button');
    this.button.id = 'help-button';
    this.button.textContent = '?';
    this.button.setAttribute('aria-label', 'Show keyboard shortcuts');
    this.button.setAttribute('title', 'Shortcuts · 단축키 (?)');
    doc.body.appendChild(this.button);

    this.overlay = doc.createElement('div');
    this.overlay.id = 'help-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'help-title');

    const card = doc.createElement('div');
    card.className = 'help-card';

    const close = doc.createElement('button');
    close.className = 'help-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    card.appendChild(close);
    close.addEventListener('click', () => this.close());

    const h2 = doc.createElement('h2');
    h2.id = 'help-title';
    h2.textContent = 'Keyboard shortcuts · 단축키';
    card.appendChild(h2);

    const sub = doc.createElement('div');
    sub.className = 'help-sub';
    sub.textContent = 'Press ? to toggle. Hover an agent to preview; click to open details.';
    card.appendChild(sub);

    for (const sec of SECTIONS) {
      const h3 = doc.createElement('h3');
      h3.textContent = sec.title;
      card.appendChild(h3);
      const dl = doc.createElement('dl');
      for (const [key, desc] of sec.rows) {
        const dt = doc.createElement('dt'); dt.textContent = key;
        const dd = doc.createElement('dd'); dd.textContent = desc;
        dl.appendChild(dt); dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    const footer = doc.createElement('div');
    footer.className = 'help-footer';
    footer.innerHTML = '<span>agent-world · Claude session visualizer</span><span>Esc or ? to close</span>';
    card.appendChild(footer);

    this.overlay.appendChild(card);
    doc.body.appendChild(this.overlay);
  }

  _bind() {
    this.button.addEventListener('click', () => this.toggle());
    this.overlay.addEventListener('click', (ev) => {
      if (ev.target === this.overlay) this.close();
    });
    // Both "?" and Shift+/ map to the same KeyboardEvent on all layouts,
    // but bind both just in case. Ignore when typing in a text field.
    this._onKey = (ev) => {
      const tag = ev.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
        ev.preventDefault();
        this.toggle();
      } else if (this.isOpen && ev.key === 'Escape') {
        this.close();
      }
    };
    this.window.addEventListener('keydown', this._onKey);
  }

  open() {
    this.isOpen = true;
    this.overlay.dataset.open = '1';
  }

  close() {
    this.isOpen = false;
    this.overlay.dataset.open = '0';
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  destroy() {
    this.window.removeEventListener('keydown', this._onKey);
    if (this.button.parentNode) this.button.parentNode.removeChild(this.button);
    if (this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
  }
}
