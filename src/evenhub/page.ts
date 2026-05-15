/**
 * Text-only page composition for G2.
 *
 * The page shape is static after startup: one hidden event-capture container and one
 * visible screen container. A fixed layout avoids costly rebuilds during gameplay.
 *
 * `composeStartupPage` is used once at app start via `createStartUpPageContainer`.
 * `composeRebuildPage` is used after a disconnect+reconnect via `rebuildPageContainer`
 * (the SDK requires `createStartUp` is one-shot per session).
 */
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

const CONTAINER_ID_EVENT = 1;
const CONTAINER_NAME_EVENT = "evt";
export const CONTAINER_ID_TEXT = 2;
export const CONTAINER_NAME_TEXT = "screen";

const DISPLAY_W = 576;
const DISPLAY_H = 288;

function createEventCaptureContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_W,
    height: DISPLAY_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: CONTAINER_ID_EVENT,
    containerName: CONTAINER_NAME_EVENT,
    content: " ",
    isEventCapture: 1,
  });
}

function createTextScreenContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_W,
    height: DISPLAY_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: CONTAINER_ID_TEXT,
    containerName: CONTAINER_NAME_TEXT,
    content,
    isEventCapture: 0,
  });
}

export function composeStartupPage(initialText: string): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [createEventCaptureContainer(), createTextScreenContainer(initialText)],
  });
}

export function composeRebuildPage(initialText: string): RebuildPageContainer {
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [createEventCaptureContainer(), createTextScreenContainer(initialText)],
  });
}
