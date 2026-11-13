import type { LessonV3 } from "../../shared/lesson-v3.js";

// The copy team's voice-revised closure lesson: the "zh-TW" entry of server/fixtures/closure-lesson.json
// (from design/v3/learning/copy/closure-lesson.json, with the figure review's code formatting). It is
// the few-shot example in the v3 author prompt and must pass the validator with no issues; a test
// keeps it identical to the fixture.
export const LESSON_V3_EXAMPLE: LessonV3 = {
  "format": 3,
  "title": "閉包：函式的隨身背包",
  "question": "外層函式都跑完了，裡面的變數怎麼還在？",
  "answer": "函式被帶走時，會把當下看得到的變數一起留住。就算外層已經結束，你還是**能讀、也能改**它。",
  "steps": [
    {
      "id": "s1",
      "lead": "交出去的函式，還抓著外層的 `count`",
      "body": "`increment` 就寫在 `createCounter` 裡面，天生看得到 `count`。就算 `createCounter` 跑完收工了，只要 `increment` 還在你手上，這條連線就不會斷。函式加上它留住的變數，就是閉包。",
      "figure": {
        "kind": "annotated-code",
        "file": "counter.js",
        "language": "javascript",
        "source": "function createCounter(initial = 0) {\n  let count = initial;\n  return function increment() {\n    count += 1;\n    return count;\n  };\n}\n\nconst counter = createCounter();",
        "focus": [
          2,
          3,
          9
        ],
        "notes": [
          {
            "line": 2,
            "text": "每次呼叫 `createCounter`，都會準備一個**全新的** `count`。"
          },
          {
            "line": 3,
            "text": "`increment` 寫在裡面，天生看得到這個 `count`。"
          },
          {
            "line": 9,
            "text": "這裡只先拿到函式，還沒呼叫它，所以 `count` 停在 0。"
          }
        ]
      },
      "analogy": {
        "title": "像留著備份鑰匙",
        "text": "鐵門拉下來了，工具還在裡面；鑰匙在你口袋，隨時能開門進去用。"
      },
      "recall": {
        "question": "`createCounter()` 跑完之後，`count` 為什麼沒被清掉？",
        "answer": "還有人用得到它。交出去的 `increment` 還抓著 `count`，所以記憶體不會清掉。",
        "hint": "想想看，現在誰手上還握著 `count`？"
      }
    },
    {
      "id": "s2",
      "lead": "留住的是變數本人，不是當下的快照",
      "body": "每次呼叫 `counter()`，你改到的都是同一個 `count`。閉包留住的是「走回那個變數的路」，不是建立那一刻拍下的死數字。看 `count` 欄，數字會一路往上接。",
      "figure": {
        "kind": "state",
        "vars": [
          "count"
        ],
        "rows": [
          {
            "moment": "建立時",
            "code": "createCounter()",
            "values": {
              "count": {
                "to": "0"
              }
            }
          },
          {
            "moment": "第 1 次呼叫",
            "code": "counter()",
            "values": {
              "count": {
                "from": "0",
                "to": "1"
              }
            },
            "output": "1"
          },
          {
            "moment": "第 2 次呼叫",
            "code": "counter()",
            "values": {
              "count": {
                "from": "1",
                "to": "2"
              }
            },
            "output": "2"
          },
          {
            "moment": "第 3 次呼叫",
            "code": "counter()",
            "values": {
              "count": {
                "from": "2",
                "to": "3"
              }
            },
            "output": "3"
          }
        ],
        "caption": "看 count 欄：每次呼叫都接著上一次的數字往上加。"
      },
      "deeper": {
        "summary": "別處改了變數，閉包看到的也會變",
        "body": "閉包握著的是通往外層變數的連線，不是複製一份出來。如果同一個外層裡還有別的函式把 `count` 改成 100，你下一次呼叫 `counter()` 就會拿到 101。這也是以前在 `for` 迴圈裡用 `var` 常踩坑的原因：好幾個函式抓到同一個變數，最後印出來全是迴圈跑完的終點值。"
      },
      "recall": {
        "question": "建立 `counter` 後連續呼叫三次，第三次會回傳多少？",
        "answer": "3。三次呼叫改的都是同一個 `count`，會從 2 再往上加 1。",
        "hint": "這三次呼叫改到的，是不是同一個 `count`？",
        "blank": {
          "kind": "state-output",
          "row": 3
        }
      }
    },
    {
      "id": "s3",
      "lead": "再呼叫一次工廠，就會分到全新的背包",
      "body": "再跑一次 `createCounter(10)`，就會生出另一個獨立的 `count`。`anotherCounter` 從 10 起跳，不管你按幾次，都不會動到原本 `counter` 裡面的數字。",
      "figure": {
        "kind": "compare",
        "items": [
          {
            "title": "`counter`"
          },
          {
            "title": "`anotherCounter`"
          }
        ],
        "rows": [
          {
            "label": "怎麼建立",
            "values": [
              "`createCounter()`",
              "`createCounter(10)`"
            ]
          },
          {
            "label": "起始值",
            "values": [
              "0",
              "10"
            ]
          },
          {
            "label": "呼叫 1 次",
            "values": [
              "1",
              "11"
            ]
          }
        ],
        "verdict": "長得一模一樣，但各自的 `count` 互不干擾。"
      },
      "analogy": {
        "title": "像同一本記帳格",
        "text": "影印給兩家便當店，欄位一樣，但帳各記各的。"
      },
      "recall": {
        "question": "分別建立的兩個計數器，會共用同一個 `count` 嗎？",
        "answer": "不會。每次呼叫 `createCounter` 都會生出獨立的 `count`，兩邊各算各的。",
        "hint": "每次呼叫 `createCounter`，第 2 行做了什麼？",
        "blank": {
          "kind": "compare",
          "item": 1,
          "row": 2
        }
      }
    }
  ],
  "followUps": [
    "為什麼把 `createCounter()` 寫在點擊事件裡，數字永遠停在 1？",
    "想同時提供 `increment` 和 `reset`，怎麼讓它們共用同一個 `count`？"
  ],
  "source": {
    "label": "JavaScript 閉包與獨立計數器"
  }
};
