import type { ColorValue } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const ThemedRect = withUniwind(Rect);

/** The DoeDesk mark: a doe with her eyes struck out. With `withBar`, the bar takes the accent colour. */
export function DoeDeskMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly withBar?: boolean;
}) {
  const aspectRatio = 20 / 19.5;
  return (
    <Svg
      accessibilityLabel="DoeDesk"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="2 2.5 20 19.5"
    >
      <ThemedPath
        d="M2.5 3C7 3 10 5.5 10.5 9.05c.5-.1 1-.15 1.5-.15s1 .05 1.5.15C14 5.5 17 3 21.5 3c.3 4.1-1.3 7.2-4.3 8.6.3.6.5 1.3.5 2 0 3.1-2.3 6-4.8 7.7a1.6 1.6 0 0 1-1.8 0c-2.5-1.7-4.8-4.6-4.8-7.7 0-.7.2-1.4.5-2C3.8 10.2 2.2 7.1 2.5 3zM7.3 12v2.6h9.4V12z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        fillRule="evenodd"
      />
      {props.withBar ? (
        <ThemedRect
          x={7.3}
          y={12}
          width={9.4}
          height={2.6}
          colorClassName="accent-primary"
          fill="currentColor"
        />
      ) : null}
    </Svg>
  );
}
