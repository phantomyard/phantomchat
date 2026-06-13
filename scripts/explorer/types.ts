export type PageId = 'A' | 'B';

export type AtomicAction =
  | {type: 'click'; page: PageId; selector: string}
  | {type: 'fill'; page: PageId; selector: string; value: string}
  | {type: 'press'; page: PageId; key: string}
  | {type: 'navigate'; page: PageId; url: string}
  | {type: 'wait'; ms: number}
  | {type: 'evaluate'; page: PageId; script: string};

export interface Observation {
  page: PageId;
  screenshotPath?: string;
  consoleTail: string[];
  url: string;
  capturedAt: number;
}
