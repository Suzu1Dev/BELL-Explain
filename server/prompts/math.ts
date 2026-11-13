// Lessons typeset \( \) and \[ \] with KaTeX. $ is never a delimiter: notes are
// full of shell variables and prices, so the models are asked not to use it either.
// A display formula over several lines is typeset only with \[ and \] on lines of their own.
const delimiters = String.raw`需要寫數學式時用 LaTeX：行內用 \( … \)，獨立成行用 \[ … \]（可以跨行：\[ 與 \] 各自單獨一行，中間不要空一行），不要用 $ 當分隔符。只有真正的數學式才這樣寫；程式碼、指令、路徑、價格與一般數字不要包進去。`;
const json = String.raw`JSON 字串中的反斜線照常跳脫，例如 "\\(x^2\\)"。`;
// Backticks are the only way to keep a regex's or command's \( and \[ as written.
const tick = "`";
export const mathRule = `${delimiters}文字中提到程式碼、指令、正規表示式或路徑時一律放進反引號，例如 ${tick}grep '\\[ERROR\\]' app.log${tick}，反引號裡的 \\( 與 \\[ 會照原樣顯示。${json}`;
/** For transcribing a page, which must not change it: the same LaTeX, but code is kept as printed, with no backticks added. */
export const transcriptionMathRule = `${delimiters}頁面上的程式碼、指令與正規表示式照頁面原樣轉寫，不要另加反引號。${json}`;
