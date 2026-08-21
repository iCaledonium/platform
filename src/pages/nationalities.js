// Session 148 — nationality select data. ISO 3166-1 alpha-2 codes; the
// flag emoji is DERIVED from the code (each letter -> its regional
// indicator symbol), so no flag assets and no library — every code
// renders its correct flag by construction. List covers the countries
// a Deliver Worlds cast plausibly draws from; extend freely, the flag
// comes along for free.
//
// Session 149 — extracted out of CharacterWizard.jsx into its own module
// so ActorsEditorPage.jsx can share the exact same list/flag logic
// instead of a second copy drifting out of sync.
export function flagEmoji(code) {
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

export const NATIONALITIES = [
  ["US","United States"],["MX","Mexico"],["CA","Canada"],["BR","Brazil"],["AR","Argentina"],["CO","Colombia"],
  ["GB","United Kingdom"],["IE","Ireland"],["FR","France"],["DE","Germany"],["ES","Spain"],["PT","Portugal"],
  ["IT","Italy"],["NL","Netherlands"],["BE","Belgium"],["CH","Switzerland"],["AT","Austria"],["SE","Sweden"],
  ["NO","Norway"],["DK","Denmark"],["FI","Finland"],["IS","Iceland"],["PL","Poland"],["CZ","Czechia"],
  ["HU","Hungary"],["RO","Romania"],["GR","Greece"],["UA","Ukraine"],["RU","Russia"],["TR","Türkiye"],
  ["IL","Israel"],["LB","Lebanon"],["EG","Egypt"],["MA","Morocco"],["NG","Nigeria"],["GH","Ghana"],
  ["ET","Ethiopia"],["KE","Kenya"],["ZA","South Africa"],["IR","Iran"],["IQ","Iraq"],["SA","Saudi Arabia"],
  ["AE","United Arab Emirates"],["IN","India"],["PK","Pakistan"],["BD","Bangladesh"],["LK","Sri Lanka"],
  ["CN","China"],["TW","Taiwan"],["HK","Hong Kong"],["JP","Japan"],["KR","South Korea"],["PH","Philippines"],
  ["VN","Vietnam"],["TH","Thailand"],["ID","Indonesia"],["MY","Malaysia"],["SG","Singapore"],["AU","Australia"],
  ["NZ","New Zealand"],["CU","Cuba"],["DO","Dominican Republic"],["JM","Jamaica"],["HT","Haiti"],
  ["GT","Guatemala"],["SV","El Salvador"],["HN","Honduras"],["PE","Peru"],["CL","Chile"],["VE","Venezuela"],
  ["AM","Armenia"],["GE","Georgia"],["KZ","Kazakhstan"],
];
