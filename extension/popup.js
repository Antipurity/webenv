document.getElementById('server-url').onfocus = evt => evt.target.select()



// Keep track of `--x` and `--y` CSS variables, for all buttons. (Also predict the next position a bit.)
function setMousePosition(evt) {
  for (let b of [...document.querySelectorAll('button.button')]) {
    const r = b.getBoundingClientRect()
    const x = evt.clientX + evt.movementX - r.left, y = evt.clientY + evt.movementY - r.top
    b.style.setProperty('--x', x+'px')
    b.style.setProperty('--y', y+'px')
  }
}
addEventListener('mouseover', setMousePosition, {passive:true})
addEventListener('mousemove', setMousePosition, {passive:true})



if (navigator.webdriver) document.querySelector('body>.controls').textContent = '<Already auto-controlled, stop fooling around>'