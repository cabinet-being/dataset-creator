export const selectFileNameStem = (input: HTMLInputElement) => {
  const extensionStart = input.value.lastIndexOf('.');
  if (extensionStart > 0) {
    input.setSelectionRange(0, extensionStart);
    return;
  }
  input.select();
};
