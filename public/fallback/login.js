/* global document */

(() => {
  const passwordInput = document.querySelector('#password');
  const toggleButton = document.querySelector('#togglePassword');
  if (!passwordInput || !toggleButton) return;

  toggleButton.addEventListener('click', () => {
    const nextType = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = nextType;
  });
})();
