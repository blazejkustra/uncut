// D245 (#91): Settings › Labs. One switch per flag in FLAGS (labs.ts), remembered on this Mac.
import { FLAG_IDS, FLAGS, setFlag, useFlag, type Flag } from "./labs.ts";
import "./labs.css";

export function LabsSettings() {
  return (
    <div data-testid="labs-settings">
      <div className="group">
        <p className="labs-lead">Features still being built. They're off until you turn them on here, on this Mac. Turning one off keeps what it made; only its buttons are disabled.</p>
        {FLAG_IDS.map((flag) => (
          <LabRow key={flag} flag={flag} />
        ))}
      </div>
    </div>
  );
}

function LabRow({ flag }: { flag: Flag }) {
  const on = useFlag(flag);
  return (
    <label className="lab-row" data-testid={`lab-${flag}`} data-on={on}>
      <span className="lab-text">
        <span className="lab-name">{FLAGS[flag].label}</span>
        <span className="lab-desc">{FLAGS[flag].description}</span>
      </span>
      <input type="checkbox" role="switch" className="lab-switch" data-testid={`lab-${flag}-toggle`} checked={on} onChange={(e) => setFlag(flag, e.target.checked)} />
    </label>
  );
}
