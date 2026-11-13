import { AnnotatedText } from "../ReadingAnnotations";

export default function V3Text({ text, sourceKey }: { text: string; sourceKey: string }) {
  return <AnnotatedText text={text} sourceKey={sourceKey} math />;
}
