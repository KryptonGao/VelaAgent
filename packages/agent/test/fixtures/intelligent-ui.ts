export const billSplit = [
  '{"op":"begin","id":"split-1","version":1,"title":"账单平摊"}',
  '{"op":"state","name":"amount","kind":"number","initial":240,"min":0}',
  '{"op":"state","name":"people","kind":"number","initial":5,"min":1}',
  '{"op":"node","id":"root","type":"column","props":{}}',
  '{"op":"node","id":"amountInput","parent":"root","type":"number_input","props":{"label":"总额","unit":"元","bind":"amount"}}',
  '{"op":"node","id":"peopleInput","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}',
  '{"op":"node","id":"total","parent":"root","type":"stat","props":{"label":"每人金额","unit":"元","digits":2,"derive":{"op":"round","args":[{"op":"divide","args":[{"ref":"amount"},{"ref":"people"}]},2]}}}',
  '{"op":"commit"}',
];

export function fenced(lines: string[], fence = "```"): string {
  return `${fence}vela-ui\n${lines.join("\n")}\n${fence}`;
}
