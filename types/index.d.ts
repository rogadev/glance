/** What glance.mjs last decided for this session, as the desktop band draws it. */
export type Pane = {
  state: 'working' | 'attention'
  /** CONFIG.workingColor in glance.mjs, so the band and the tint match; empty until glance.mjs first reports. */
  color: string
}

declare module 'claude-code' {
  interface PluginState {
    glance: { pane: Shaped<Pane> }
  }
}
