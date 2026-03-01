/**
 * Text-only page composition for G2.
 *
 * The page shape is static after startup: one hidden event-capture container and one
 * visible screen container. A fixed layout avoids costly rebuilds during gameplay.
 */
import {
  CreateStartUpPageContainer,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

export const CONTAINER_ID_EVENT = 1;
export const CONTAINER_NAME_EVENT = "evt";
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
  // Keep input capture decoupled from visible board text. This prevents long content
  // from interfering with swipe/tap delivery on device firmware paths that couple
  // interaction with scrollable text containers.
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [createEventCaptureContainer(), createTextScreenContainer(initialText)],
  });
}
