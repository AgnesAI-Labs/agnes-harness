/** Literal ratchet: legacy call sites are explicit, only new controls/colours are refused. */
export function controlPresentationCounts(source: string): Record<string, number> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => ' '.repeat(text.length))
    .replace(/^[ \t]*\/\/.*$/gm, (text) => ' '.repeat(text.length))
    .replace(/<!--[\s\S]*?-->/g, (text) => ' '.repeat(text.length))
  const counts: Record<string, number> = {}
  const add = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  for (const match of code.matchAll(
    /<(?:input|select)\b[^>]*>|\.createElement\(\s*['"](?:input|select)['"]\s*\)/g,
  )) {
    if (/^<input\b/.test(match[0]) && /\btype\s*=\s*\{?\s*['"](?:hidden|file)['"]/.test(match[0])) continue
    add(`raw-control:${match[0].replace(/\s+/g, ' ').trim()}`)
  }
  const names =
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
      .split(' ')
      .join('|')
  for (const match of code.matchAll(/#[a-f\d]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)/gi))
    add(`color:${match[0].toLowerCase()}`)
  const named = new RegExp(
    `(?:color|background(?:Color|-color)?|border(?:Color|-color)?|fill|stroke)\\s*:\\s*['"]?[^;{}'"\\n]*?\\b(?:${names})\\b`,
    'gi',
  )
  for (const match of code.matchAll(named)) add(`color:${match[0].toLowerCase()}`)
  return counts
}
export function newControlPresentationViolations(
  current: Record<string, number>,
  allowed: Record<string, number>,
): string[] {
  return Object.entries(current)
    .filter(([key, count]) => count > (allowed[key] ?? 0))
    .map(([key, count]) => `${key}: ${count} > ${allowed[key] ?? 0}`)
}
