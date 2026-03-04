import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Container, Graphics, Text, TextStyle, type Application } from "pixi.js";
import type { Task } from "../../types";
import { DESK_H, type Delivery } from "./model";

interface BuildFinalLayersParams {
  app: Application;
  tasks: Task[];
  ceoPosRef: MutableRefObject<{ x: number; y: number }>;
  agentPosRef: MutableRefObject<Map<string, { x: number; y: number }>>;
  deliveriesRef: MutableRefObject<Delivery[]>;
  deliveryLayerRef: MutableRefObject<Container | null>;
  highlightRef: MutableRefObject<Graphics | null>;
  prevAssignRef: MutableRefObject<Set<string>>;
  setSceneRevision: Dispatch<SetStateAction<number>>;
}

export function buildFinalLayers({
  app,
  tasks,
  ceoPosRef,
  agentPosRef,
  deliveriesRef,
  deliveryLayerRef,
  highlightRef,
  prevAssignRef,
  setSceneRevision,
}: BuildFinalLayersParams): void {
  const deliveryLayer = new Container();
  app.stage.addChild(deliveryLayer);
  deliveryLayerRef.current = deliveryLayer;

  deliveriesRef.current = deliveriesRef.current.filter((delivery) => !delivery.sprite.destroyed);
  for (const delivery of deliveriesRef.current) {
    deliveryLayer.addChild(delivery.sprite);
  }

  const highlight = new Graphics();
  app.stage.addChild(highlight);
  highlightRef.current = highlight;

  const currentAssign = new Set(
    tasks.filter((task) => task.assigned_agent_id && task.status === "in_progress").map((task) => task.id),
  );
  const newAssigns = [...currentAssign].filter((id) => !prevAssignRef.current.has(id));
  prevAssignRef.current = currentAssign;

  for (const taskId of newAssigns) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task?.assigned_agent_id) continue;
    const target = agentPosRef.current.get(task.assigned_agent_id);
    if (!target) continue;

    const deliverySprite = new Container();
    const docEmoji = new Text({ text: "\u{1F4CB}", style: new TextStyle({ fontSize: 16 }) });
    docEmoji.anchor.set(0.5, 0.5);
    deliverySprite.addChild(docEmoji);
    deliverySprite.position.set(ceoPosRef.current.x, ceoPosRef.current.y);
    deliveryLayer.addChild(deliverySprite);

    deliveriesRef.current.push({
      sprite: deliverySprite,
      fromX: ceoPosRef.current.x,
      fromY: ceoPosRef.current.y,
      toX: target.x,
      toY: target.y + DESK_H,
      progress: 0,
    });
  }

  setSceneRevision((prev) => prev + 1);
}
