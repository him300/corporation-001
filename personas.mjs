/**
 * The roster. Names, roles and order are shared by the live market and the replay
 * engine so the two views always describe the same five participants.
 */
export const ROSTER = [
  { id: 'mm', name: 'Aurelia', role: 'market maker', blurb: 'quotes both sides, carries the inventory' },
  { id: 'mom', name: 'Kestrel', role: 'momentum', blurb: 'follows the tape' },
  { id: 'val', name: 'Hollis', role: 'value', blurb: 'buys under fair value' },
  { id: 'news', name: 'Vega', role: 'news', blurb: 'trades the headline' },
  { id: 'mm2', name: 'Nyx', role: 'scalper', blurb: 'lifts the spread' },
];

export const byId = (id) => ROSTER.find((r) => r.id === id);
