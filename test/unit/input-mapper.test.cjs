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
    assert.equal(mapEvenHubEventToInput(textEvent(OsEventTypeList.SCROLL_TOP_EVENT)), "move_left");
    clock.advance(2);
    assert.equal(mapEvenHubEventToInput(textEvent(OsEventTypeList.SCROLL_BOTTOM_EVENT)), "move_right");
  });
});

test("raw scroll debounce drops duplicate callbacks inside 1ms", () => {
  withFakeClock((clock) => {
    const evt = textEvent(OsEventTypeList.SCROLL_TOP_EVENT);
    assert.equal(mapEvenHubEventToInput(evt), "move_left");
    assert.equal(mapEvenHubEventToInput(evt), null);
    clock.advance(1.1);
    assert.equal(mapEvenHubEventToInput(evt), "move_left");
  });
});

test("tap and double tap dedupe windows are enforced", () => {
  withFakeClock((clock) => {
    const tap = textEvent(OsEventTypeList.CLICK_EVENT);
    const doubleTap = textEvent(OsEventTypeList.DOUBLE_CLICK_EVENT);

    assert.equal(mapEvenHubEventToInput(tap), "move_up");
    clock.advance(5);
    assert.equal(mapEvenHubEventToInput(tap), null);
    clock.advance(6);
    assert.equal(mapEvenHubEventToInput(tap), "move_up");

    clock.advance(1);
    assert.equal(mapEvenHubEventToInput(doubleTap), "toggle_pause");
    clock.advance(80);
    assert.equal(mapEvenHubEventToInput(doubleTap), null);
    clock.advance(61);
    assert.equal(mapEvenHubEventToInput(doubleTap), "toggle_pause");
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
