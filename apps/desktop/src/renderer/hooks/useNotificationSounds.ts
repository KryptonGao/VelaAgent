import { useCallback, useEffect, useState } from "react";
import { NotificationSoundPlayer, type NotifySound } from "../notification-sounds";

export function useNotificationSounds(enabled: boolean) {
  const [player] = useState(() => new NotificationSoundPlayer());
  useEffect(() => { player.setEnabled(enabled); }, [enabled, player]);

  useEffect(() => {
    const unlock = () => { void player.unlock(); };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
      player.dispose();
    };
  }, [player]);

  const notify = useCallback<NotifySound>(sound => { void player.play(sound); }, [player]);
  const preview = useCallback<NotifySound>(sound => { void player.play(sound, true); }, [player]);
  return { notify, preview };
}
