import { Select } from "./ui/Form";

export const CURRENCIES = ["USD", "EUR", "GBP", "TRY", "JPY", "CAD", "AUD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "BRL", "MXN", "INR", "CNY", "KRW", "SGD", "HKD", "NZD", "ZAR", "AED", "SAR", "ILS"];

const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "currency" }) : null;

export function CurrencySelect({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const list = CURRENCIES.includes(value) ? CURRENCIES : [value, ...CURRENCIES];
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((c) => (
        <option key={c} value={c}>
          {c} — {names?.of(c) ?? c}
        </option>
      ))}
    </Select>
  );
}
