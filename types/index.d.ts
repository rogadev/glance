/** What glance.mjs last decided for this session, as the desktop band draws it. */
export type Pane = {
  state: 'working' | 'standby' | 'attention'
  /**
   * The color glance.mjs gives the band, so the band and the tint match:
   * CONFIG.standbyColor on standby, CONFIG.workingColor otherwise. Empty until
   * glance.mjs first reports.
   */
  color: string
}

declare module 'claude-code' {
  interface PluginState {
    glance: { pane: Shaped<Pane> }
  }
}
