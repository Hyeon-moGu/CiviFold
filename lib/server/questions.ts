// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Category, RequestItem } from "../tools/types";

const SUBJECT: Record<Category, string> = {
  fire_hydrant: "hydrant",
  streetlight: "street light",
  traffic_sign: "sign",
  bench: "bench",
  road_damage: "damaged spot",
  trash: "pile",
  graffiti: "graffiti",
  other: "problem",
};

/** The one question a resident gets when the rules need more, in plain words. */
export function templateQuestion(item: RequestItem, category: Category): string {
  const subject = SUBJECT[category];
  switch (item) {
    case "wider_context":
      return `Could you take one more photo from a few steps back, so the ${subject} and the buildings or signs around it are both visible?`;
    case "different_angle":
      return `Could you take a photo of the ${subject} from another side?`;
    case "close_up":
      return `Could you take a close-up photo of the ${subject}, so the problem itself is clearly visible?`;
    case "photo":
      return `Could you add a photo of the ${subject} with the buildings or signs around it? Similar reports nearby can only be told apart by a photo.`;
    case "observed_time":
      return "When did you take this photo? If it was before today, please tell us the date and time.";
  }
}
