const test = require("node:test");
const assert = require("node:assert/strict");

const { OsEventTypeList } = require("@evenrealities/even_hub_sdk");
const { setPerfNowProvider, resetPerfLogState } = require("../../.test-dist/perf/log.js");
const {
  mapEvenHubEventToInput,
  resetInputMapperStateForTests,
} = require("../../.test-dist/input/mapper.js");

function withFakeClock(run) {
  let now = 1000;
  setPerfNowProvider(() => now);
  resetPerfLogState();
  resetInputMapperStateForTests();
  const api = {
    set: (value) => {
      now = value;
    },
    advance: (delta) => {
      now += delta;
    },
  };
  try {
    run(api);
  } finally {
    setPerfNowProvider(null);
    resetPerfLogState();
    resetInputMapperStateForTests();
  }
}

function textEvent(eventType) {
  return { textEvent: { containerID: 1, containerName: "evt", eventType } };
}

test("scroll events map to horizontal moves", () => {
  withFakeClock((clock) => {
    assert.equal(mapEvenHubEventToInput(textEvent(OsEventTypeList.SCROLL_TOP_EVENT)), "move_right");
    clock.advance(12);
    assert.equal(mapEvenHubEventToInput(textEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT)), "move_left");
  });
});

test("raw scroll debounce drops duplicate callbacks inside 12ms", () => {
  withFakeClock((clock) => {
    const evt = textEvent(OsEventTypeList.SCROLL_TOP_EVENT);
    assert.equal(mapEvenHubEventToInput(evt), "move_right");
    assert.equal(mapEvenHubEventToInput(evt), null);
    clock.advance(12.1);
    assert.equal(mapEvenHubEventToInput(evt), "move_right");
  });
});

test("scroll dedupe accepts event exactly at 12ms threshold", () => {
  withFakeClock((clock) => {
    const evt = textEvent(OsEventTypeList.SCROLL_TOP_EVENT);
    assert.equal(mapEvenHubEventToInput(evt), "move_right");
    clock.advance(12);
    assert.equal(mapEvenHubEventToInput(evt), "move_right");
  });
});

test("tap maps to move_up and double tap maps to restart", () => {
  withFakeClock((clock) => {
    const tap = textEvent(OsEventTypeList.CLICK_EVENT);
    const doubleTap = textEvent(OsEventTypeList.DOUBLE_CLICK_EVENT);

    assert.equal(mapEvenHubEventToInput(tap), "move_up");
    clock.advance(100);
    const mappedDoubleTap = mapEvenHubEventToInput(doubleTap);
    assert.equal(mappedDoubleTap, "restart");
    assert.notEqual(mappedDoubleTap, "toggle_pause");
  });
});

test("fallback null eventType with list selection maps to tap/up", () => {
  withFakeClock(() => {
    const listTap = {
      listEvent: {
        containerID: 1,
        containerName: "evt",
        eventType: null,
        currentSelectItemIndex: 2,
      },
    };
    assert.equal(mapEvenHubEventToInput(listTap), "move_up");
  });
});

test("tap and double-tap dedupe accept events at exact thresholds", () => {
  withFakeClock((clock) => {
    const tap = textEvent(OsEventTypeList.CLICK_EVENT);
    const doubleTap = textEvent(OsEventTypeList.DOUBLE_CLICK_EVENT);

    assert.equal(mapEvenHubEventToInput(tap), "move_up");
    clock.advance(130);
    assert.equal(mapEvenHubEventToInput(tap), "move_up");

    clock.advance(100);
    assert.equal(mapEvenHubEventToInput(doubleTap), "restart");
    clock.advance(20);
    assert.equal(mapEvenHubEventToInput(doubleTap), "restart");
  });
});

test("duplicate firmware tap within 130ms is dropped (no double forward hop)", () => {
  withFakeClock((clock) => {
    const tap = textEvent(OsEventTypeList.CLICK_EVENT);

    assert.equal(mapEvenHubEventToInput(tap), "move_up");
    // Firmware duplicate ~70ms later — must NOT produce a second move_up.
    clock.advance(70);
    assert.equal(mapEvenHubEventToInput(tap), null);
    // A genuine second tap past the window is still accepted.
    clock.advance(130);
    assert.equal(mapEvenHubEventToInput(tap), "move_up");
  });
});
