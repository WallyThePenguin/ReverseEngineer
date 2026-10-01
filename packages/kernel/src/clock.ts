export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can set and advance. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(to: Date | string): void {
    this.t = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
