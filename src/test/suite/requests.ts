// The regression suite: six real requests, in the maker's own words, each
// with what the maker says if the chat asks for more. The live suite
// (suite-live.test.ts) takes each one through the whole journey in the
// chat; the recorded run (suite.test.ts) checks the same plans offline.

export interface SuiteRequest {
  id: string;
  name: string;
  // The first message, as a maker typed it.
  says: string;
  // What the maker answers when the chat asks something, one a turn.
  answers: string[];
}

export const SUITE: SuiteRequest[] = [
  {
    id: "motivation",
    name: "Morning motivation",
    says: "Every morning at 8, send me a Telegram message with a short motivational line for the day.",
    answers: ["Just the one message each morning. It never needs to ask me anything first.", "That's everything, make it."],
  },
  {
    id: "sales",
    name: "Daily sales total",
    says: "Every evening, read my Google Sheet of daily sales, one row per sale with an Amount column, add up today's total and how many sales there were, and send me the totals on Telegram.",
    answers: ["Each row also has a Date column. It only reads the sheet and messages me; it never needs to ask me anything.", "That's everything, make it."],
  },
  {
    id: "enquiries",
    name: "Enquiry priority",
    says: "Every hour, check my Google Sheet of customer enquiries for new rows. For each new row, decide whether it's urgent or not urgent, and write the answer in a Priority column of that row. Leave rows I've already checked alone.",
    answers: ["Each row has a Message column with what the customer wrote. A row is checked once its Priority is filled in. It never needs to ask me anything.", "That's everything, make it."],
  },
  {
    id: "price",
    name: "Price watcher",
    says: "Every day, check a product page I give you and read its price. If the price is below a target I set, ask me on Telegram whether I want a reminder to buy it, and only send the reminder if I say yes.",
    answers: ["It's one product. I'll give you the page link and my target price when I set it up. It must never send the reminder unless I say yes.", "That's everything, make it."],
  },
  {
    id: "supplies",
    name: "Supplies restock",
    says: "Every Monday, check my Google Sheet of supplies. If any item's quantity is below its minimum, work out the cost to restock it at the price in the sheet, and ask me on Telegram before paying the supplier saved as a payee.",
    answers: ["The sheet has Item, Quantity, Minimum and Price columns. Restocking means buying enough to get back up to the minimum. It must never pay without my yes.", "That's everything, make it."],
  },
  {
    id: "hackathon",
    name: "Hackathon Submission Checker",
    says: "Make me a Hackathon Submission Checker. Submissions arrive as rows in a Google Sheet. Every 15 minutes, check the new rows. For each submission, judge each requirement in my list as met or not met, one requirement at a time. Count the met ones: fewer than half met means rejected, otherwise passed. Write Status and Reasons into that submission's own row, with Reasons naming each requirement as met or not met. Then send me one Telegram summary covering every submission checked. The next run should leave checked rows alone.",
    answers: ["I'll give you the list of requirements when I set it up. A row is checked once its Status is filled in. It never needs to ask me anything.", "That's everything, make it."],
  },
];
