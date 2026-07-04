import { useEffect, useState } from "react";
import { api, FileContent, ImageBox } from "../api";
import { BOX_COLORS } from "./util";

interface Props {
  fileId: string;
  boxes: ImageBox[];
}

/** A marked-up image rendered inside a chat bubble. */
export default function ChatAnnotatedImage({ fileId, boxes }: Props) {
  const [img, setImg] = useState<FileContent | null>(null);

  useEffect(() => {
    api
      .getFileContent(fileId)
      .then(setImg)
      .catch(() => setImg(null));
  }, [fileId]);

  if (!img || img.kind !== "image" || !img.dataB64) return null;
  return (
    <div className="img-wrap chat-img">
      <img src={`data:${img.mime};base64,${img.dataB64}`} alt={img.name} />
      {boxes.map((b, i) => {
        const color = BOX_COLORS[i % BOX_COLORS.length];
        return (
          <div
            key={i}
            className="img-box"
            style={{
              left: `${b.x1 * 100}%`,
              top: `${b.y1 * 100}%`,
              width: `${(b.x2 - b.x1) * 100}%`,
              height: `${(b.y2 - b.y1) * 100}%`,
              borderColor: color,
            }}
          >
            <span className="img-box-label" style={{ background: color }}>
              {b.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
