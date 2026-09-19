const WIDGET_STYLES = {
  globalStyleText: `
    button[aria-label*="语音聊天"],
    button[aria-label*="語音聊天"],
    button[aria-label*="voice chat" i],
    button[aria-label*="chat de voz" i],
    button[aria-label*="Sprach-Chat" i],
    button[aria-label*="chat vocal" i],
    button[aria-label*="音声チャット"],
    button[aria-label*="开始新的语音"],
    button[aria-label*="開始新的語音"],
    button[aria-label*="Start a new voice" i],
    button[aria-label*="Start voice chat" i],
    div.flex.items-center.gap-1 > span.contents:has(> button) {
      display: none !important;
    }
  `,
  styleText: `
    :host { display: inline-flex; flex: 0 0 auto; align-items: center; align-self: center; margin-left: auto; height: var(--height-token-row, 29px); }
    * { box-sizing: border-box; }
    button, input, textarea, select { font: inherit; }
    .quota-wrap { position: relative; display: inline-flex; align-items: center; align-self: center; height: var(--height-token-row, 29px); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .quota-chip {
      appearance: none; border: 0; border-radius: var(--radius-lg, 12.5px); corner-shape: var(--codex-corner-shape, superellipse(1.5)); cursor: pointer;
      height: var(--height-token-row, 29px); min-width: 0; padding: 0; padding-inline: var(--padding-row-cell-x, var(--padding-row-x, 8px));
      display: inline-flex; align-items: center; justify-content: center; align-self: center;
      gap: 4px; background: transparent; color: var(--token-text-secondary, #777780);
      font: 500 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .quota-chip:hover, .quota-chip:focus-visible {
      color: inherit;
      background-color: var(--color-background-primary-ghost-hover, rgba(26, 28, 31, 0.053));
      outline: none;
    }
    .quota-divider { opacity: .42; font-weight: 400; }
    .quota-chip-item { display: inline-flex; align-items: baseline; }
    .host-health-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 999px; background: #d97706; box-shadow: 0 0 0 2px rgba(217,119,6,.13); }
    .host-health-dot.ready { background: #43a665; box-shadow: 0 0 0 2px rgba(67,166,101,.13); }
    .host-health-dot.degraded { background: #dc4c3f; box-shadow: 0 0 0 2px rgba(220,76,63,.14); }
    .host-health-dot.direct { background: #5b8fc9; box-shadow: 0 0 0 2px rgba(91,143,201,.13); }
    .host-health-dot.idle, .host-health-dot.unknown { background: #8a8a95; box-shadow: 0 0 0 2px rgba(138,138,149,.13); }
    .is-warning { color: #d97706 !important; }
    .is-critical { color: #dc4c3f !important; }
    .quota-popover {
      position: fixed; inset: auto auto 58px 12px; margin: 0;
      display: flex; flex-direction: column;
      width: min(430px, calc(100vw - 24px)); max-height: 720px; overflow: hidden;
      padding: 0; border-radius: 16px;
      color: var(--token-foreground, #f4f4f7); background: var(--token-main-surface-primary, #191923);
      background-clip: padding-box;
      border: 1px solid var(--token-border, rgba(255,255,255,.09));
      box-shadow: 0 16px 44px rgba(0,0,0,.38);
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985);
      transform-origin: right bottom; pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
    }
    .panel-scroll {
      width: 100%; min-height: 0; flex: 1 1 auto; overflow: auto; overflow-anchor: none;
      padding: 0 14px 14px; border-radius: 0 0 16px 16px;
    }
    .detail-popover { padding: 6px 6px 0 0; }
    .detail-popover .panel-scroll {
      padding: 0 8px 14px 14px;
    }
    .panel-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
    .panel-scroll::-webkit-scrollbar-track { margin-block: 12px; background: transparent; }
    .panel-scroll::-webkit-scrollbar-thumb {
      border: 3px solid transparent; border-radius: 999px; background: rgba(127,127,137,.62);
      background-clip: content-box;
    }
    .quota-wrap.is-open .quota-popover {
      opacity: 1; visibility: visible; transform: translateY(0) scale(1); pointer-events: auto;
    }
    .quota-wrap.is-dismissed .quota-popover {
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985); pointer-events: none;
    }
    .panel-head { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px 10px; }
    .detail-popover > .panel-head { padding: 9px 10px 10px 16px; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-title-wrap { display: flex; align-items: baseline; min-width: 0; gap: 7px; }
    .panel-subtitle { margin-top: 3px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; font-weight: 400; }
    .panel-count { margin-left: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 12px; font-weight: 500; }
    .panel-controls { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .turn-state-status {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 28px; height: 20px; padding: 0 6px; border-radius: 7px;
      color: #8a8a95; background: rgba(138,138,149,.12);
      font: 650 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      font-variant-numeric: tabular-nums; cursor: default;
    }
    .turn-state-status.match { color: #71c98c; background: rgba(67,166,101,.13); }
    .turn-state-status.mismatch { color: #ef8e86; background: rgba(220,76,63,.13); }
    .host-health-status {
      appearance: none; display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 0; border: 0; border-radius: 7px; cursor: default;
      color: inherit; background: transparent;
    }
    .host-health-status:hover, .host-health-status:focus-visible { background: rgba(255,255,255,.075); outline: none; }
    .host-health-status .host-health-dot { width: 8px; height: 8px; flex-basis: 8px; box-shadow: none; }
    .icon-btn { appearance: none; width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer; color: inherit; background: transparent; }
    .icon-btn:hover { background: rgba(255,255,255,.07); }
    .provider-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; color: var(--token-text-secondary, #777780);
      background: transparent;
      font: 650 11px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: -.35px;
    }
    .provider-icon-btn:hover, .provider-icon-btn:focus-visible {
      color: inherit; background: rgba(255,255,255,.07); outline: none;
    }
    .accounts-head, .accounts-head .panel-title-wrap { align-items: center; }
    .accounts-head .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 26px; width: 26px; height: 26px; padding: 0; line-height: 1;
    }
    .accounts-head .icon-btn svg { display: block; width: 12px; height: 12px; flex: 0 0 auto; }
    .account-list { display: grid; gap: 8px; }
    .account-card { padding: 11px 12px; border: 1px solid rgba(255,255,255,.07); border-radius: 12px; background: rgba(255,255,255,.025); }
    .account-card.current { border-color: rgba(217,184,255,.33); background: rgba(217,184,255,.055); }
    .account-card.transferred { opacity: .76; border-style: dashed; }
    .account-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .account-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
    .badges { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .badge { padding: 2px 6px; border-radius: 999px; background: rgba(255,255,255,.07); color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 16px; }
    .badge.current { color: #d9b8ff; background: rgba(217,184,255,.12); }
    .badge.transferred { color: #e5b86a; background: rgba(229,184,106,.1); }
    button.badge { appearance: none; border: 0; cursor: pointer; font: inherit; }
    button.badge:hover { background: rgba(229,184,106,.18); }
    .expiry { margin-top: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10.5px; line-height: 15px; }
    .account-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; white-space: nowrap; }
    .window-list { display: grid; gap: 7px; margin-top: 9px; }
    .window-row { display: grid; grid-template-columns: 58px 42px minmax(70px, 1fr); align-items: center; gap: 5px 8px; font-size: 11px; }
    .window-label { color: var(--token-text-secondary, #aaaab5); }
    .window-left { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .window-track { height: 4px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); }
    .window-track i { display: block; height: 100%; border-radius: inherit; background: #d9b8ff; }
    .window-subline { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--token-text-secondary, #aaaab5); font-size: 10.5px; line-height: 15px; }
    .window-credit { color: var(--token-text-secondary, #aaaab5); }
    .window-reset { margin-left: auto; text-align: right; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); }
    .btn { appearance: none; border: 1px solid rgba(255,255,255,.11); border-radius: 8px; cursor: pointer; padding: 5px 9px; color: inherit; background: rgba(255,255,255,.045); font-size: 11px; }
    .btn:hover { background: rgba(255,255,255,.09); }
    .btn.primary { border-color: rgba(217,184,255,.24); color: #e5cdfd; background: rgba(217,184,255,.1); }
    .btn:disabled { cursor: default; opacity: .45; }
    .account-switch { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; }
    .account-remove { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; color: #ef8e86; border-color: rgba(220,76,63,.2); background: rgba(220,76,63,.06); }
    .account-remove:hover { background: rgba(220,76,63,.12); }
    .account-head .badges > .badge, .account-head .badges > .btn {
      display: inline-flex; align-items: center; justify-content: center;
      height: 22px; padding-top: 0; padding-bottom: 0;
      font-size: 10.5px; font-weight: 500; line-height: 16px;
    }
    .account-tooltip { position: fixed; inset: auto; margin: 0; width: max-content; max-width: min(320px, calc(100vw - 24px)); padding: 7px 10px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: #f4f4f7; background: #24242d; box-shadow: 0 6px 20px rgba(0,0,0,.25); font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none; }
    .empty { padding: 18px 8px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 12px; }
    .operation { margin-top: 9px; padding: 8px 10px; border-radius: 9px; overflow-wrap: anywhere; background: rgba(255,255,255,.045); color: var(--token-text-secondary, #b5b5bf); font-size: 11px; }
    .operation.has-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .operation.has-action span { min-width: 0; }
    .operation .oauth-cancel { flex: 0 0 auto; padding: 3px 7px; }
    .operation.success { color: #7ecb9b; background: rgba(52,168,92,.09); }
    .operation.error { color: #ef8e86; background: rgba(220,76,63,.09); }
    .host-health-banner { display: grid; gap: 7px; margin-bottom: 11px; padding: 10px 11px; border: 1px solid rgba(229,184,106,.28); border-radius: 11px; color: #f2cf8e; background: rgba(229,184,106,.09); font-size: 10.5px; line-height: 15px; }
    .host-health-banner.idle { color: #aaaab5; border-color: rgba(138,138,149,.22); background: rgba(138,138,149,.06); }
    .host-health-banner.degraded { border-color: rgba(220,76,63,.3); color: #f3a49e; background: rgba(220,76,63,.09); }
    .host-health-title { font-size: 11.5px; font-weight: 700; }
    .host-health-detail { color: var(--token-text-secondary, #b5b5bf); overflow-wrap: anywhere; }
    .host-health-missing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .host-health-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .host-health-actions .btn { padding: 4px 8px; }
    .host-health-checks { margin: 8px 0; padding-left: 18px; display: grid; gap: 6px; }
    .host-health-details-content { display: grid; gap: 7px; }
    .host-health-banner.ready { color: #43a665; border-color: rgba(67,166,101,.3); background: rgba(67,166,101,.07); }
    .host-health-banner.starting { color: #aaaab5; border-color: rgba(138,138,149,.22); background: rgba(138,138,149,.06); }
    .panel-version { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); color: var(--token-text-secondary, #aaaab5); font-size: 10px; font-weight: 400; }
    .panel-version-text { margin-left: auto; color: var(--token-text-secondary, #aaaab5); white-space: nowrap; }
    .panel-balance { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .add-panel { margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(255,255,255,.07); }
    .add-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toolbar-actions { display: flex; align-items: center; gap: 7px; }
    .add-title { font-size: 12px; font-weight: 650; }
    .add-options { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .migration-form { display: grid; gap: 10px; padding: 0; }
    .migration-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .migration-option { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 8px; padding: 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 11px; cursor: pointer; background: rgba(255,255,255,.025); }
    .migration-option.selected { border-color: rgba(217,184,255,.3); background: rgba(217,184,255,.055); }
    .migration-option input { width: auto; margin: 2px 0 0; }
    .migration-option-title { display: block; font-size: 12px; font-weight: 650; }
    .migration-option-note { display: block; margin-top: 4px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .migration-account-list { display: grid; gap: 6px; }
    .migration-account-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 8px 9px; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    .migration-account-row input { width: auto; margin: 0; }
    .migration-account-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .migration-account-state { color: var(--token-text-secondary, #aaaab5); font-size: 10px; white-space: nowrap; }
    .migration-current-note { padding: 8px 9px; border-radius: 9px; color: #e5b86a; background: rgba(229,184,106,.08); font-size: 10px; line-height: 15px; }
    .migration-actions { display: flex; justify-content: flex-end; }
    details { grid-column: 1 / -1; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    summary { cursor: pointer; padding: 7px 9px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    form { display: grid; gap: 7px; padding: 0 9px 9px; }
    input, textarea, select { width: 100%; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; outline: none; padding: 7px 8px; color: inherit; background: rgba(0,0,0,.16); font-size: 11px; }
    textarea { min-height: 70px; resize: vertical; }
    input:focus, textarea:focus, select:focus { border-color: rgba(217,184,255,.4); }
    .quota-error { margin-top: 7px; color: #ef8e86; font-size: 10px; }
    .context-summary { display: grid; gap: 6px; margin-bottom: 10px; padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .context-status { font-size: 12px; font-weight: 650; }
    .context-status.system-default { color: #7ecb9b; }
    .context-status.applied { color: #d9b8ff; }
    .context-status.pending { color: #e5b86a; }
    .context-status.external { color: #e5b86a; }
    .context-status.unavailable { color: #ef8e86; }
    .context-note { color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .context-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    .context-toolbar-actions { display: flex; align-items: center; gap: 6px; }
    .model-list { display: grid; gap: 7px; }
    .model-card { padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .model-card.overridden { border-color: rgba(217,184,255,.3); background: rgba(217,184,255,.055); }
    .model-head { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
    .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
    .model-slug { margin-top: 2px; color: var(--token-text-secondary, #aaaab5); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .model-actions { display: flex; align-items: center; flex: 0 0 auto; gap: 5px; }
    .model-values { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .model-value { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 7px; background: rgba(0,0,0,.12); font-size: 10px; }
    .model-value span { color: var(--token-text-secondary, #aaaab5); }
    .model-value strong { font-variant-numeric: tabular-nums; }
    .model-max { margin-top: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .context-edit-form { display: grid; gap: 8px; margin-top: 9px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.07); }
    .context-edit-form[hidden] { display: none !important; }
    .context-field { display: grid; gap: 4px; }
    .context-field label { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .context-field input { font-variant-numeric: tabular-nums; }
    .context-advanced { border: 1px solid rgba(255,255,255,.07); border-radius: 8px; }
    .context-advanced summary { padding: 6px 8px; }
    .context-advanced .context-field { padding: 0 8px 8px; }
    .context-edit-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .context-empty { padding: 22px 10px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    .provider-summary { display: grid; gap: 6px; margin-bottom: 10px; padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .provider-status { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 650; }
    .provider-status .enabled { color: #7ecb9b; }
    .provider-status .disabled { color: var(--token-text-secondary, #aaaab5); }
    .provider-note { color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .provider-form { display: grid; gap: 9px; padding: 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .provider-field { display: grid; gap: 5px; }
    .provider-field label { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .provider-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .provider-toggle { display: flex; align-items: center; gap: 7px; font-size: 11px; }
    .provider-toggle input { width: auto; margin: 0; }
    .provider-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .provider-warning { color: #e5b86a; font-size: 10px; line-height: 15px; }
    .wakeup-times { display: grid; gap: 7px; }
    .wakeup-time-row { display: flex; align-items: center; gap: 8px; }
    .wakeup-time-row label { flex: 0 0 auto; font-size: 11px; }
    .wakeup-time-row input { min-width: 0; }
    .wakeup-time-row button { flex: 0 0 auto; }
    .wakeup-result { line-height: 1.6; }
    .btn.wakeup-status:not(.primary) { color: var(--token-text-secondary, #aaaab5); }
    .wakeup-status:focus-visible { outline: 1px solid currentColor; outline-offset: 3px; border-radius: 2px; }
    .wakeup-form { margin-top: 9px; padding: 0; }
    .extra-platform-list { display: grid; gap: 8px; }
    .extra-platform-card { padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .extra-platform-card .btn { padding: 2px 7px; border-radius: 7px; font-size: 10px; line-height: 16px; }
    .extra-platform-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .extra-platform-head .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
    .extra-platform-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
    .extra-platform-url { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .extra-platform-meta { margin-top: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-platform-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-platform-form { display: grid; gap: 9px; padding: 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .extra-models-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; font-size: 11px; font-weight: 650; }
    .extra-model-list { display: grid; gap: 7px; }
    .extra-model-row { display: grid; grid-template-columns: minmax(0,1fr); align-items: end; gap: 7px; padding: 8px; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    .extra-model-row .provider-field { min-width: 0; }
    .extra-model-row .provider-toggle { align-self: center; white-space: nowrap; }
    .extra-model-remove { justify-self: end; }
    .extra-model-capabilities { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-model-capabilities .model-label { margin-right: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .extra-model-capabilities .badge.pending { color: #e5b86a; }
    .extra-model-settings { display: grid; gap: 8px; min-width: 0; }
    .extra-model-settings summary { cursor: pointer; font-size: 11px; }
    .extra-model-settings-body { display: grid; gap: 8px; padding-top: 8px; }
    .extra-model-detection-error { color: #dc4941; font-size: 11px; overflow-wrap: anywhere; white-space: normal; margin: 6px 0; }
    .extra-model-detection-detail { color: var(--token-text-secondary, #aaaab5); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
    .extra-model-main-status.detection-failed { color: #b42318; background: #b4231810; }
    .extra-model-unsaved { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid rgba(251,191,36,.4); border-radius: 999px; color: #fbbf24; background: rgba(251,191,36,.14); font-size: 10px; font-weight: 700; line-height: 16px; white-space: nowrap; }
    .quota-wrap.is-light .extra-model-unsaved { color: #9a4d00; background: #fff1d6; border-color: rgba(217,119,6,.4); }
    .extra-model-detect { justify-self: start; }
    .extra-platform-model-status { display: grid; gap: 12px; margin-top: 7px; }
    .extra-platform-model-status > [data-model-index] { display: grid; gap: 8px; min-width: 0; }
    .extra-model-status { display: grid; gap: 6px; }
    .extra-model-inline-progress:empty, .extra-platform-progress:empty, .extra-model-feedback:empty { display: none; }
    .extra-platform-progress .operation, .extra-model-feedback .operation { margin-top: 7px; white-space: normal; overflow-wrap: anywhere; }
    .extra-model-progress { display: flex; align-items: flex-start; gap: 7px; }
    .extra-model-progress::before { content: ""; width: 10px; height: 10px; flex: 0 0 auto; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: extra-model-spin .8s linear infinite; }
    .extra-model-progress-body { display: grid; flex: 1 1 auto; min-width: 0; gap: 5px; }
    .extra-model-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .extra-model-progress-title { min-width: 0; overflow-wrap: anywhere; }
    .extra-model-progress-percent { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .extra-model-progress-track { height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.09); }
    .extra-model-progress-track i { display: block; height: 100%; border-radius: inherit; background: currentColor; transition: width .18s ease; }
    .extra-model-progress-detail { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    @keyframes extra-model-spin { to { transform: rotate(360deg); } }
    .extra-model-reasoning { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); align-items: end; gap: 8px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.07); }
    .extra-model-efforts { display: flex; flex-wrap: wrap; gap: 6px 10px; }
    .extra-model-efforts-label { width: 100%; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-model-efforts .provider-toggle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
    .preset-model-picker { border: 1px solid rgba(255,255,255,.07); border-radius: 9px; overflow: hidden; }
    .preset-model-picker summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; cursor: pointer; color: inherit; }
    .preset-model-picker summary::marker { color: var(--token-text-secondary, #aaaab5); }
    .preset-model-options { display: grid; gap: 0; padding: 0 9px 7px; }
    .preset-model-option { display: grid; gap: 7px; padding: 7px 0; border-top: 1px solid rgba(255,255,255,.07); }
    .preset-model-option-select { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: start; gap: 7px; }
    .preset-model-option-select > input { width: auto; margin: 2px 0 0; }
    .preset-model-option-main { min-width: 0; }
    .preset-model-option-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 650; }
    .preset-model-option-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .preset-model-context { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .preset-model-context input { min-width: 0; margin: 0; }
    .preset-platform-note { display: grid; gap: 3px; padding: 8px 9px; border-radius: 8px; background: rgba(255,255,255,.035); color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .balance-section { margin-top: 10px; }
    .balance-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; font-size: 11px; }
    .balance-grid { display: grid; gap: 7px; }
    .balance-card { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 9px 10px; border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.025); font-size: 10px; white-space: nowrap; }
    .balance-currency { flex: 0 0 auto; color: var(--token-text-secondary, #aaaab5); font-size: inherit; }
    .balance-total { flex: 0 0 auto; font-size: inherit; font-weight: inherit; font-variant-numeric: tabular-nums; }
    .balance-detail { min-width: 0; margin-left: auto; overflow: hidden; color: var(--token-text-secondary, #aaaab5); font-size: inherit; text-overflow: ellipsis; }
    .quota-wrap.is-light .quota-popover { color: #202124; background: #fff; border-color: rgba(0,0,0,.12); box-shadow: 0 16px 44px rgba(0,0,0,.18); }
    .quota-wrap.is-light .account-card { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
    .quota-wrap.is-light .account-card.current { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .badge { color: #676771; background: rgba(0,0,0,.055); }
    .quota-wrap.is-light .badge.current { color: #754694; background: rgba(116,69,143,.1); }
    .quota-wrap.is-light .badge.transferred { color: #9a6500; background: rgba(154,101,0,.09); }
    .quota-wrap.is-light .expiry, .quota-wrap.is-light .window-label, .quota-wrap.is-light .window-reset,
    .quota-wrap.is-light .window-credit, .quota-wrap.is-light .window-subline,
    .quota-wrap.is-light summary, .quota-wrap.is-light .empty { color: #6f6f79; }
    .quota-wrap.is-light .window-track { background: rgba(0,0,0,.08); }
    .quota-wrap.is-light .window-track i { background: #9b68bb; }
    .quota-wrap.is-light .btn { color: #2f3035; border-color: rgba(0,0,0,.12); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .btn:hover { background: rgba(0,0,0,.065); }
    .quota-wrap.is-light .btn.primary { color: #71438e; border-color: rgba(116,69,143,.28); background: rgba(116,69,143,.08); }
    .quota-wrap.is-light .host-health-banner { color: #8a5b00; border-color: rgba(154,101,0,.25); background: rgba(154,101,0,.07); }
    .quota-wrap.is-light .host-health-banner.idle { color: #666672; border-color: rgba(138,138,149,.22); background: rgba(138,138,149,.06); }
    .quota-wrap.is-light .host-health-banner.degraded { color: #a7352e; border-color: rgba(181,61,53,.24); background: rgba(181,61,53,.06); }
    .quota-wrap.is-light .host-health-detail { color: #6f6f79; }
    .quota-wrap.is-light .host-health-status:hover, .quota-wrap.is-light .host-health-status:focus-visible { background: rgba(0,0,0,.065); }
    .quota-wrap.is-light .turn-state-status { color: #6f6f79; background: rgba(138,138,149,.1); }
    .quota-wrap.is-light .turn-state-status.match { color: #2f7f4a; background: rgba(67,166,101,.1); }
    .quota-wrap.is-light .turn-state-status.mismatch { color: #a7352e; background: rgba(220,76,63,.09); }
    .quota-wrap.is-light .account-remove { color: #b53d35; border-color: rgba(181,61,53,.2); background: rgba(181,61,53,.045); }
    .quota-wrap.is-light .account-remove:hover { background: rgba(181,61,53,.09); }
    .quota-wrap.is-light .account-tooltip { color: #202124; background: #fff; border-color: rgba(0,0,0,.12); box-shadow: 0 6px 20px rgba(0,0,0,.12); }
    .quota-wrap.is-light .icon-btn:hover { background: rgba(0,0,0,.06); }
    .quota-wrap.is-light .provider-icon-btn {
      color: #70717c; background: transparent;
    }
    .quota-wrap.is-light .provider-icon-btn:hover, .quota-wrap.is-light .provider-icon-btn:focus-visible {
      color: #363740; background: rgba(0,0,0,.06);
    }
    .quota-wrap.is-light .wakeup-status:not(.primary) { color: #6f6f79; }
    .quota-wrap.is-light .add-panel, .quota-wrap.is-light .panel-version, .quota-wrap.is-light details { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light input, .quota-wrap.is-light textarea, .quota-wrap.is-light select { color: #202124; border-color: rgba(0,0,0,.13); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .operation { color: #666670; background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .extra-model-progress-track { background: rgba(0,0,0,.09); }
    .quota-wrap.is-light .context-summary, .quota-wrap.is-light .model-card,
    .quota-wrap.is-light .provider-summary, .quota-wrap.is-light .provider-form,
    .quota-wrap.is-light .balance-card, .quota-wrap.is-light .extra-platform-card,
    .quota-wrap.is-light .extra-platform-form, .quota-wrap.is-light .migration-option,
    .quota-wrap.is-light .migration-account-row { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
    .quota-wrap.is-light .migration-option.selected { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .extra-model-row, .quota-wrap.is-light .extra-model-reasoning { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light .model-card.overridden { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .model-value { background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .context-edit-form, .quota-wrap.is-light .context-advanced { border-color: rgba(0,0,0,.09); }
  `,
};

export { WIDGET_STYLES };
