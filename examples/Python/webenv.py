# 1 day in development.



import sys
import asyncio
import numpy as np



def js_executor(code):
    # Note: shlex.quote(code) quotes improperly on Windows.
    code = '"' + code.replace('\\', '\\\\').replace('"', '\\"') + '"'
    import shutil
    if shutil.which('nodejs') is not None:
        return 'nodejs -e ' + code
    return 'node -e ' + code
def webenv(agent, *interfaces, int_size=0, webenv_path='webenv', js_executor=js_executor):
    """
    A Python wrapper for creating and connecting to a local Web environment.
    Pass in the agent and all the interfaces. This will loop infinitely.

    (This does not have an OpenAI-Gym-like interface, because that does not incorporate asynchronicity directly.)

    Arguments:

    - `agent`: an async function, from observations and the recommended action length (a number), to a tuple of predictions and actions, all NumPy arrays and -1…1|NaN unless specified.
    For throughput, immediately send commands to another device, and return an `await`able Future.
    To stop this web env, `raise` an exception.

    - `interfaces`: a list of either strings (which are put as-is as JS code, where `we` is the webenv module) or structured args.
    Args are a convenience: numbers and bools are put as-is, strings are escaped unless at the top-level, arrays become function calls (with the first string item being the unescaped function to call), dicts become objects.

    - `int_size`: increase throughput at the cost of precision. `0` communicates through float32, `1` through int8, `2` through int16. Do not specify `we.io(X)` manually.

    - `webenv_path`: what the generated JS should `require`. `'webenv'` by default.

    - `js_executor`: the function from generated JS to the executed system command; escape quotes manually. Uses NodeJS directly by default.

    Example:

    >>> import webenv
    >>> webenv.webenv(lambda x: x, '"https://www.youtube.com/watch?v=dQw4w9WgXcQ"', 'we.defaults', ['we.randomAgent'])
    """
    if not callable(agent):
        raise TypeError('Agent must be a function')
    if int_size != 0 and int_size != 1 and int_size != 2:
        raise TypeError('Int size must be 0 (float32) or 1 (int8) or 2 (int16)')
    code = _js_code_for_interfaces(interfaces, int_size, webenv_path)
    cmd = js_executor(code)
    prev_agent_call = None
    prev_flush_info = [None]
    async def step(reader, writer, readFuture):
        nonlocal prev_agent_call
        obs, act_len = await _read_all(reader, int_size)
        readFuture.set_result(None)
        prevW = prev_agent_call
        nextW = prev_agent_call = asyncio.Future()
        pred, act = await agent(obs, act_len)
        if asyncio.isfuture(prevW): await prevW # Ensure linear ordering of writes.
        nextW.set_result(None)
        _write_all(writer, int_size, pred, act)
        await _flush(writer, prev_flush_info)
    async def steps(cmd):
        P = asyncio.subprocess.PIPE
        proc = await asyncio.create_subprocess_shell(cmd, stdin=P, stdout=P)
        proc.stdin.transport.set_write_buffer_limits(0, 0)
        reader, writer = proc.stdout, proc.stdin
        _write_u32(writer, 0x01020304)
        await _flush(writer, prev_flush_info)
        while True:
            read = asyncio.Future()
            asyncio.create_task(step(reader, writer, read))
            await read
    asyncio.run(steps(cmd))
async def _read_all(stream, int_size):
    obs = _decode(await _read_data(stream, int_size))
    # Bug: if there are too few observations (<4095), this fails to read `obs`'s length correctly.
    act_len = await _read_u32(stream)
    return obs, act_len
def _write_all(stream, int_size, pred, act):
    if pred.dtype != np.float32:
        raise TypeError('Predictions should be a float32 array')
    if act.dtype != np.float32:
        raise TypeError('Actions should be a float32 array')
    _write_data(stream, _encode(pred, int_size))
    _write_data(stream, _encode(act, int_size))
async def _flush(stream, prev_flush):
    # `stream.drain()` can only be called one at a time, so we await the previous flush.
    prev = prev_flush[0]
    fut = prev_flush[0] = asyncio.Future()
    if prev is not None: await prev
    await stream.drain()
    fut.set_result(None)
async def _read_n(stream, n):
    return await stream.readexactly(n)
async def _read_u32(stream):
    bytes = await _read_n(stream, 4)
    return int.from_bytes(bytes, sys.byteorder)
def _write_u32(stream, x):
    stream.write(x.to_bytes(4, sys.byteorder))
async def _read_data(stream, int_size = 0):
    # Length then data.
    len = await _read_u32(stream)
    byteCount = len*4 if int_size == 0 else len*int_size
    bytes = await _read_n(stream, byteCount)
    dtype = np.float32 if int_size == 0 else np.int8 if int_size == 1 else np.int16
    return np.frombuffer(bytes, dtype)
def _write_data(stream, data):
    # Length then data. Don't forget to flush afterwards.
    _write_u32(stream, data.size)
    stream.write(data.tobytes())
def _decode(ints):
    if ints.dtype == np.float32:
        return ints
    scale = 127 if ints.dtype == np.int8 else 32767
    nanValue = -scale-1
    x = ints.astype(np.float32)
    return np.where(x == nanValue, np.nan, x / scale)
def _encode(floats, int_size = 0):
    if int_size == 0:
        return floats
    scale = 127 if int_size == 1 else 32767
    nanValue = -scale-1
    rounded = np.where(np.isnan(floats), nanValue, np.rint(np.clip(floats, -1, 1) * scale))
    dtype = np.int8 if int_size == 1 else np.int16
    return rounded.astype(dtype)
def _js_code_for_interfaces(inters, int_size, webenv_path):
    code = "const we = require('" + webenv_path + "');"
    code += "we.init(we.io(" + str(int_size) + "),"
    for i in inters:
        if isinstance(i, str):
            code = code + i + ','
        else:
            code = code + _js_code_for_args(i) + ','
    code = code + ")"
    return code
def _js_code_for_args(a):
    if isinstance(a, int) or isinstance(a, float):
        return str(a)
    if isinstance(a, bool):
        return 'true' if a else 'false'
    if isinstance(a, str):
        return "`" + a.replace("`", "\\`") + "`"
    if isinstance(a, list):
        if not isinstance(a[0], str):
            raise TypeError('Interfaces can only call JS-string functions')
        return a[0] + "(" + ",".join([_js_code_for_args(x) for x in a[1:]]) + ")"
    if isinstance(a, dict):
        return "{" + ",".join([k + ":" + _js_code_for_args(a[k]) for k in a]) + "}"
    raise TypeError('Bad arg')