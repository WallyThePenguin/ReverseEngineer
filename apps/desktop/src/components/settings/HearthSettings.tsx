// Hearth: the address of your Hearth and the pairing code from its Settings (Desktop app), which
// "Connect Hearth on this PC" there fills in by itself (D53). Paired, dictation is cleaned with
// your Hearth dictionary, snippets and styles and kept in your history there, and two more
// hotkeys reach Jarvis. Hearth's own window, quick capture and Ask Jarvis have hotkeys too.
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";
import { SettingsGroup } from "../ui/SettingsGroup";
import { ShortcutInput } from "./ShortcutInput";

export const HearthSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, refreshSettings } = useSettings();
  const paired = Boolean(getSetting("hearth_keys")?.desktop);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const shownUrl = url ?? getSetting("hearth_url") ?? "http://localhost:4400";

  const save = async () => {
    setBusy(true);
    try {
      const res = await commands.changeHearthSettings(shownUrl, code);
      setNote(
        res.status === "ok"
          ? { ok: true, text: res.data }
          : { ok: false, text: res.error },
      );
      setCode("");
      await refreshSettings();
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    await commands.unpairHearth();
    setNote(null);
    await refreshSettings();
  };

  return (
    <SettingsGroup title={t("settings.hearth.title")}>
      <SettingContainer
        title={t("settings.hearth.address")}
        description={t("settings.hearth.addressHelp")}
        grouped={true}
      >
        <Input
          value={shownUrl}
          onChange={(e) => setUrl(e.target.value)}
          className="w-64"
        />
      </SettingContainer>
      <SettingContainer
        title={paired ? t("settings.hearth.paired") : t("settings.hearth.code")}
        description={t("settings.hearth.codeHelp")}
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={code}
            placeholder={
              paired
                ? t("settings.hearth.repairPlaceholder")
                : t("settings.hearth.pastePlaceholder")
            }
            onChange={(e) => setCode(e.target.value)}
            className="w-64"
          />
          <Button onClick={() => void save()} disabled={busy}>
            {paired && !code
              ? t("settings.hearth.check")
              : t("settings.hearth.save")}
          </Button>
          {paired && (
            <Button variant="danger-ghost" onClick={() => void unpair()}>
              {t("settings.hearth.unpair")}
            </Button>
          )}
        </div>
      </SettingContainer>
      {note && (
        <p
          className={`px-4 pb-2 text-sm ${note.ok ? "text-green-600" : "text-red-500"}`}
        >
          {note.text}
        </p>
      )}
      <ShortcutInput
        shortcutId="hearth_command"
        grouped={true}
        disabled={!paired}
      />
      <ShortcutInput
        shortcutId="hearth_talk"
        grouped={true}
        disabled={!paired}
      />
      {/* Hearth's own windows sign in by themselves, so these work unpaired too. */}
      <ShortcutInput shortcutId="hearth_open" grouped={true} />
      <ShortcutInput shortcutId="hearth_capture" grouped={true} />
      <ShortcutInput shortcutId="hearth_ask" grouped={true} />
    </SettingsGroup>
  );
};
