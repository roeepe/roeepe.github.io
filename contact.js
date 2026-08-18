// Assembles the contact address at runtime so it never appears in page source.
document.addEventListener("DOMContentLoaded", function () {
  var parts = ["roee.pearl", "gmail.com"];
  var addr = parts[0] + String.fromCharCode(64) + parts[1];
  Array.prototype.forEach.call(document.querySelectorAll("[data-contact]"), function (el) {
    var a = document.createElement("a");
    a.href = "mailto:" + addr;
    a.textContent = addr;
    el.replaceWith(a);
  });
});
