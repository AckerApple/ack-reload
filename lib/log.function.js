module.exports = function(){
  const args = Array.prototype.slice.call(arguments)
  args.unshift('\x1b[36m[ack-reload]\x1b[0m')
  console.log.apply(console,args)
}

module.exports.error = function(){
  const args = Array.prototype.slice.call(arguments)
  args.unshift('\x1b[31m[ack-reload]\x1b[0m')
  console.error.apply(console,args)
}