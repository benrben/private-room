import { useEffect, useState } from "react";
import { api, FileContent, ImageBox } from "../api";
import { BOX_COLORS } from "./util";
import { fileUrl } from "./useFileBytes";

interface Props {
  fileId: string;
  boxes: ImageBox[];
}

function imageSource(img: FileContent | null): string | null {
  return img?.dataB64
    ? `data:${img.mime};base64,${img.dataB64}`
    : fileUrl(img?.mediaToken);
}

/** A marked-up image rendered inside a chat bubble. */
export default function ChatAnnotatedImage({ fileId, boxes }: Props) {
  const [img, setImg] = useState<FileContent | null>(null);
  // Distinguish "still loading" from "this picture can't be shown". Rendering
  // nothing for a failure reads as if the AI forgot to include the picture.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setImg(null);
    setFailed(false);
    api
      .getFileContent(fileId)
      .then((c) => {
        if (!alive) return;
        // Pictures stream over roommedia:// now; dataB64 is only ever
        // populated if byte delivery is switched back.
        if (c.kind === "image" && (c.mediaToken || c.dataB64)) setImg(c);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [fileId]);

  if (failed) {
    return (
      <div className="chat-img-missing empty-hint">
        The marked-up picture couldn’t be loaded from this room.
      </div>
    );
  }
  const src = imageSource(img);
  if (!img || img.kind !== "image" || !src) return null;
  return (
    <div className="img-wrap chat-img">
      <img
        src={src}
        alt={img.name}
        onError={() => setFailed(true)}
      />
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
