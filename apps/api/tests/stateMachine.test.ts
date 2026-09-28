import { assertTransition, canTransition } from "@rideflow/shared";

describe("ride state machine", () => {
  it("allows the happy path and the side exits", () => {
    expect(canTransition("requested", "matching")).toBe(true);
    expect(canTransition("matching", "offered")).toBe(true);
    expect(canTransition("offered", "accepted")).toBe(true);
    expect(canTransition("accepted", "arrived")).toBe(true);
    expect(canTransition("arrived", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
    expect(canTransition("offered", "expired")).toBe(true);
    expect(canTransition("matching", "no_drivers")).toBe(true);
    expect(canTransition("accepted", "cancelled")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("requested", "accepted")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
    expect(canTransition("no_drivers", "offered")).toBe(false);
    expect(() => assertTransition("offered", "in_progress")).toThrow(/Illegal ride transition/);
  });
});
