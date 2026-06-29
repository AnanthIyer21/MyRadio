// Decode HTML/XML entities to real characters. Used wherever feed/article text
// or media URLs are parsed — stripping entities (the old behaviour) deleted
// apostrophes ("don&#8217;t" -> "dont") and missed hex entities like &#x27;.

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", lsaquo: "‹", rsaquo: "›", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
  pound: "£", euro: "€", cent: "¢", yen: "¥",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", aacute: "á",
  uuml: "ü", ouml: "ö", auml: "ä", iuml: "ï", szlig: "ß", ccedil: "ç", ntilde: "ñ",
  oacute: "ó", iacute: "í", uacute: "ú", aring: "å", oslash: "ø", AElig: "Æ",
};

const fromCp = (cp) => { try { return String.fromCodePoint(cp); } catch { return ""; } };

export function decodeEntities(input = "") {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCp(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED[name] ?? NAMED[name.toLowerCase()] ?? m);
}
