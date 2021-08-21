import { getDropDuration, transitions } from "../util/animation";
import { Axis, Entity, Hitbox } from "../types";
import { DndManager } from "./DndManager";
import { DragEventData } from "./DragManager";
import { getSiblingDirection, SiblingDirection } from "../util/path";

type EntityAndElement = [Entity, HTMLElement, HTMLElement];

interface Dimensions {
  width: number;
  height: number;
}

const emptyDimensions: Dimensions = {
  width: 0,
  height: 0,
};

export const dragLeaveDebounceLength = 100;

export class SortManager {
  dndManager: DndManager;
  sortables: Map<string, EntityAndElement>;
  shifted: Set<string>;
  hidden: Set<string>;
  isSorting: boolean;
  axis: Axis;
  placeholder: EntityAndElement | null;

  sortListeners: Array<(isSorting: boolean) => void>;

  constructor(dndManager: DndManager, axis: Axis) {
    this.dndManager = dndManager;
    this.sortables = new Map();
    this.shifted = new Set();
    this.hidden = new Set();
    this.isSorting = false;
    this.axis = axis;
    this.placeholder = null;
    this.sortListeners = [];

    dndManager.dragManager.emitter.on("dragStart", this.handleDragStart);
    dndManager.dragManager.emitter.on("dragEnd", this.handleDragEnd);
    dndManager.dragManager.emitter.on("dragEnter", this.handleDragEnter);
    dndManager.dragManager.emitter.on("dragLeave", this.handleDragLeave);
  }

  destroy() {
    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEndTimeout);

    this.dndManager.dragManager.emitter.off("dragStart", this.handleDragStart);
    this.dndManager.dragManager.emitter.off("dragEnd", this.handleDragEnd);
    this.dndManager.dragManager.emitter.off("dragEnter", this.handleDragEnter);
    this.dndManager.dragManager.emitter.off("dragLeave", this.handleDragLeave);
  }

  registerSortable(
    id: string,
    entity: Entity,
    el: HTMLElement,
    measureEl: HTMLElement
  ) {
    const isPlaceholder = entity.getData().type === "placeholder";

    this.sortables.set(id, [entity, el, measureEl]);

    if (isPlaceholder) {
      this.placeholder = [entity, el, measureEl];
      measureEl.dataset.axis = this.axis;
      measureEl.style.setProperty("transition", transitions.none);
    } else {
      el.style.setProperty("transition", transitions.none);
    }
  }

  unregisterSortable(id: string) {
    this.sortables.delete(id);
  }

  hitboxDimensions = emptyDimensions;

  handleDragStart = ({
    dragEntity,
    dragEntityMargin,
    dragOriginHitbox,
  }: DragEventData) => {
    const id = dragEntity?.entityId;
    const haveDragEntity = id ? this.sortables.has(id) : null;

    if (!dragEntity || !haveDragEntity || !dragOriginHitbox) {
      return;
    }

    this.setSortState(true);

    this.hitboxDimensions = this.getHitboxDimensions(
      dragOriginHitbox,
      dragEntityMargin
    );

    this.activatePlaceholder(this.hitboxDimensions, transitions.none);

    this.sortables.forEach(([entity, el, measureEl]) => {
      const siblingDirection = getSiblingDirection(
        dragEntity.getPath(),
        entity.getPath()
      );
      const entityId = entity.entityId;

      if (siblingDirection === SiblingDirection.Self) {
        this.hidden.add(entityId);
        return this.hideDraggingEntity(measureEl);
      }

      if (siblingDirection === SiblingDirection.After) {
        if (!this.shifted.has(entityId)) {
          this.shifted.add(entityId);
        }

        this.shiftEl(el, transitions.none, this.hitboxDimensions);
      }
    });
  };

  resetSelf(maintainHidden?: boolean) {
    console.log("reset self");
    if (this.isSorting) {
      this.setSortState(false);
      this.deactivatePlaceholder();
    }

    if (this.shifted.size > 0) {
      this.shifted.forEach((entityId) => {
        if (this.sortables.has(entityId)) {
          const [, el] = this.sortables.get(entityId);
          this.resetEl(el);
        }
      });

      this.shifted.clear();
    }

    if (!maintainHidden && this.hidden.size > 0) {
      this.hidden.forEach((entityId) => {
        if (this.sortables.has(entityId)) {
          const [, , measure] = this.sortables.get(entityId);
          this.resetEl(measure);
        }
      });

      this.hidden.clear();
    }
  }

  private dragEndTimeout = 0;
  handleDragEnd = ({
    primaryIntersection,
    dragPosition,
    dragOriginHitbox,
    dragEntity,
  }: DragEventData) => {
    if (!this.isSorting || !dragPosition || !dragOriginHitbox || !dragEntity) {
      if (
        !primaryIntersection &&
        dragEntity &&
        this.sortables.has(dragEntity.entityId)
      ) {
        console.log("perform null drop");
        return this.resetSelf(false);
      }

      return this.resetSelf(true);
    }

    clearTimeout(this.dragEnterTimeout);
    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEndTimeout);

    const dropHitbox = primaryIntersection?.getHitbox() || dragOriginHitbox;
    const dropDuration = getDropDuration({
      position: dragPosition,
      destination: {
        x: dropHitbox[0],
        y: dropHitbox[1],
      },
    });

    this.dragEndTimeout = window.setTimeout(() => {
      this.setSortState(false);
      this.deactivatePlaceholder();

      if (
        primaryIntersection &&
        this.sortables.has(primaryIntersection.entityId) &&
        primaryIntersection.entityId !== dragEntity.entityId
      ) {
        console.log("calling drop from sortmanager");
        this.dndManager.onDrop(dragEntity, primaryIntersection);
      }

      this.sortables.forEach(([entity, el, measure]) => {
        const entityId = entity.entityId;

        if (this.shifted.has(entityId)) {
          this.shifted.delete(entityId);
          return this.resetEl(el, transitions.none);
        }

        if (this.hidden.has(entityId)) {
          this.hidden.delete(entityId);
          this.resetEl(measure, transitions.none);
        }
      });
    }, dropDuration - 1);

    this.hitboxDimensions = emptyDimensions;
  };

  private dragEnterTimeout = 0;
  handleDragEnter = ({
    dragEntity,
    dragEntityMargin,
    dragOriginHitbox,
    primaryIntersection,
  }: DragEventData) => {
    const id = primaryIntersection?.entityId;
    const haveSortable = id ? this.sortables.has(id) : null;

    if (
      !dragEntity ||
      !primaryIntersection ||
      !haveSortable ||
      !dragOriginHitbox
    ) {
      if (!haveSortable && this.isSorting) {
        this.resetSelf(true);
      }

      return;
    }

    if (dragEntity.entityId === primaryIntersection.entityId) {
      return;
    }

    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEnterTimeout);

    this.dragEnterTimeout = window.setTimeout(() => {
      this.setSortState(true);
      this.hitboxDimensions = this.getHitboxDimensions(
        dragOriginHitbox,
        dragEntityMargin
      );
      this.activatePlaceholder(this.hitboxDimensions, transitions.placeholder);
      this.sortables.forEach(([entity, el]) => {
        const siblingDirection = getSiblingDirection(
          primaryIntersection.getPath(),
          entity.getPath()
        );

        const entityId = entity.entityId;

        if (
          !this.hidden.has(entityId) &&
          (siblingDirection === SiblingDirection.Self ||
            siblingDirection === SiblingDirection.After)
        ) {
          if (!this.shifted.has(entityId)) {
            this.shifted.add(entityId);
          }

          this.shiftEl(el, transitions.outOfTheWay, this.hitboxDimensions);
        } else if (this.shifted.has(entityId)) {
          this.shifted.delete(entityId);
          this.resetEl(el);
        }
      });
    }, 10);
  };

  private dragLeaveTimeout = 0;
  handleDragLeave = () => {
    if (!this.isSorting) return;

    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEnterTimeout);
    this.dragLeaveTimeout = window.setTimeout(() => {
      this.setSortState(false);
      this.deactivatePlaceholder();
      this.sortables.forEach(([entity, el]) => {
        const entityId = entity.entityId;

        if (this.shifted.has(entityId)) {
          this.shifted.delete(entityId);
          this.resetEl(el);
        }
      });
    }, dragLeaveDebounceLength);

    this.hitboxDimensions = emptyDimensions;
  };

  getHitboxDimensions(hitbox: Hitbox, margin: Hitbox = [0, 0, 0, 0]) {
    const height = hitbox[3] + margin[3] - hitbox[1] - margin[1];
    const width = hitbox[2] + margin[2] - hitbox[0] - margin[0];
    return { width, height };
  }

  activatePlaceholder(
    dimensions: { width: number; height: number },
    transition: string
  ) {
    if (this.placeholder) {
      const isHorizontal = this.axis === "horizontal";
      const [, , measure] = this.placeholder;
      measure.style.setProperty("transition", transition);
      measure.style.setProperty(
        isHorizontal ? "width" : "height",
        `${isHorizontal ? dimensions.width : dimensions.height}px`
      );
    }
  }

  deactivatePlaceholder() {
    if (this.placeholder) {
      const [, , measure] = this.placeholder;
      measure.style.setProperty("transition", transitions.none);
      measure.style.removeProperty("width");
      measure.style.removeProperty("height");
    }
  }

  hideDraggingEntity(el: HTMLElement) {
    el.style.setProperty("display", "none");
  }

  shiftEl(
    el: HTMLElement,
    transition: string,
    dimensions: { width: number; height: number }
  ) {
    el.style.setProperty("transition", transition);
    el.style.setProperty(
      "transform",
      this.axis === "horizontal"
        ? `translate3d(${dimensions.width}px, 0, 0)`
        : `translate3d(0, ${dimensions.height}px, 0)`
    );
  }

  resetEl(el: HTMLElement, transition: string = transitions.outOfTheWay) {
    el.style.setProperty("transition", transition);
    el.style.removeProperty("transform");
    el.style.removeProperty("display");
  }

  addSortNotifier(fn: (isSorting: boolean) => void) {
    this.sortListeners.push(fn);
  }

  removeSortNotifier(fn: (isSorting: boolean) => void) {
    this.sortListeners = this.sortListeners.filter(
      (listener) => listener !== fn
    );
  }

  setSortState(isSorting: boolean) {
    this.isSorting = isSorting;
    this.sortListeners.forEach((fn) => fn(isSorting));
  }
}
