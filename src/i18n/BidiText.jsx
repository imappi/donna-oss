export const BidiText = ({
  children,
  direction = 'auto',
  style = null,
  className = undefined,
  ...props
}) => (
  <bdi {...props} dir={direction} style={style || undefined} className={className}>
    {children}
  </bdi>
);

export const IdentifierText = (props) => <BidiText {...props} direction="ltr" />;

export const FormattedValue = (props) => <BidiText {...props} direction="auto" />;
