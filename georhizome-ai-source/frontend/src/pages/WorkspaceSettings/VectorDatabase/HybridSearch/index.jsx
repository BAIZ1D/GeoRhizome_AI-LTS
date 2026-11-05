import { useState } from "react";
import { useTranslation } from "react-i18next";

const supportedVectorDBs = ["lancedb"];

function toSelection(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

export default function HybridSearch({ workspace, setHasChanges }) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(
    toSelection(workspace?.hybridSearch)
  );
  if (!workspace?.vectorDB || !supportedVectorDBs.includes(workspace?.vectorDB))
    return null;

  return (
    <div>
      <div className="flex flex-col">
        <label htmlFor="hybridSearch" className="block input-label">
          {t("hybrid-search.title")}
        </label>
      </div>
      <select
        id="hybridSearch"
        name="hybridSearch"
        value={selection}
        className="border-none bg-theme-settings-input-bg text-white text-sm mt-2 rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
        onChange={(e) => {
          setSelection(e.target.value);
          setHasChanges(true);
        }}
      >
        <option value="">{t("hybrid-search.option-default")}</option>
        <option value="true">{t("hybrid-search.option-on")}</option>
        <option value="false">{t("hybrid-search.option-off")}</option>
      </select>
      <p className="text-white text-opacity-60 text-xs font-medium py-1.5">
        {t("hybrid-search.description")}
      </p>
    </div>
  );
}
