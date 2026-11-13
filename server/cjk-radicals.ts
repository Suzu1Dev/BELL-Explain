// Generated from Unicode EquivalentUnifiedIdeograph-18.0.0.txt.
// CJK Radicals Supplement code points paired with their equivalent unified
// ideograph. Kangxi Radicals (U+2F00–U+2FDF) are handled by NFKC instead.
const pairs = Array.from("⺁厂⺂乛⺃乚⺄乙⺅亻⺆冂⺇𠘨⺈刀⺉刂⺊卜⺋㔾⺌小⺍小⺎兀⺏尣⺐尢⺑𡯂⺒巳⺓幺⺔彑⺕𫜹⺖忄⺗心⺘扌⺙攵⺛旡⺜日⺝月⺞歺⺟母⺠民⺡氵⺢氺⺣灬⺤爫⺥爫⺦丬⺧牛⺨犭⺩王⺪𤴔⺫目⺬示⺭礻⺮𥫗⺯糹⺰纟⺱罓⺲罒⺳㓁⺴冗⺵𦉫⺶羊⺷𦍌⺸𦍋⺹耂⺺肀⺻聿⺼肉⺽𦥑⺾艹⺿艹⻀艹⻁虎⻂衤⻃覀⻄西⻅见⻆角⻇𧢲⻈讠⻉贝⻊𧾷⻋车⻌辶⻍辶⻎辶⻏邑⻐钅⻑長⻒镸⻓长⻔门⻕𨸏⻖阝⻗雨⻘青⻙韦⻚页⻛风⻜飞⻝食⻞𩙿⻟飠⻠饣⻡𩠐⻢马⻣骨⻤鬼⻥鱼⻦鸟⻧卤⻨麦⻩黄⻪黾⻫斉⻬齐⻭歯⻮齿⻯竜⻰龙⻱龜⻲亀⻳龟");
const supplement = new Map<string, string>();
for (let index = 0; index < pairs.length; index += 2) supplement.set(pairs[index], pairs[index + 1]);

/**
 * PDF fonts that share one glyph between a radical and an ideograph (common in
 * Noto/Source Han exports) often map text back to the radical code point, so
 * 「行」 extracts as U+2F8F. Restore the ideograph without applying NFKC to the
 * whole text, which would also rewrite full-width punctuation.
 */
export function restoreCjkRadicals(text: string): string {
  return text.replace(/[\u2e80-\u2eff\u2f00-\u2fdf]/g, char => supplement.get(char) ?? (char >= "\u2f00" ? char.normalize("NFKC") : char));
}
